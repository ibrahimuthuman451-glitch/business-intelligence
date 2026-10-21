import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { organizations, payments, sales, users } from "@/db/schema";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { createInvoice, getInvoice, recordPayment } from "@/lib/finance-service";
import { DEMO_ADVISOR_EMAIL, DEMO_OWNER_EMAIL, removeDemoWorkspace, seedDemoWorkspace } from "@/db/seed-demo";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
let context: TestContext;

beforeAll(async () => {
  if (enabled) context = await createTestContext();
});

afterAll(async () => {
  if (enabled) await context.cleanup();
});

describe.skipIf(!enabled)("PostgreSQL production compatibility", () => {
  it("reports the real server version", async () => {
    const result = (await context.db.execute(sql`select version() as version`)) as unknown;
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    const version = (rows as { version: string }[])[0]?.version ?? "";
    expect(version).toMatch(/^PostgreSQL 16\./);
  });

  it("re-applies migrations idempotently", async () => {
    await expect(
      migratePostgres(context.db as never, {
        migrationsFolder: path.resolve(process.cwd(), "drizzle"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rolls back a failed transaction without partial writes", async () => {
    const org = await createOrg(context.db, { email: "pg-rollback@example.com", orgName: "PG Rollback" });
    const before = await context.db.select().from(sales).where(eq(sales.orgId, org.orgId));
    await expect(
      context.db.transaction(async (tx) => {
        await tx.insert(sales).values({
          orgId: org.orgId,
          description: "should not persist",
          amountCents: 1234,
          occurredAt: "2026-01-01",
        });
        throw new Error("rollback please");
      }),
    ).rejects.toThrow("rollback please");
    const after = await context.db.select().from(sales).where(eq(sales.orgId, org.orgId));
    expect(after).toHaveLength(before.length);
  });

  it("serializes concurrent payments so an invoice cannot be overpaid", async () => {
    const org = await createOrg(context.db, { email: "pg-concurrent@example.com", orgName: "PG Concurrent" });
    const invoice = await createInvoice(context.db, org.ctx, {
      number: "PG-RACE-1",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      status: "sent",
      lines: [{ description: "Race test", quantity: 1, unitPrice: "1000000", taxRatePercent: "0" }],
    });

    const results = await Promise.allSettled([
      recordPayment(context.db, org.ctx, {
        invoiceId: invoice.id,
        amount: "600000",
        paidAt: "2026-01-10",
      }),
      recordPayment(context.db, org.ctx, {
        invoiceId: invoice.id,
        amount: "600000",
        paidAt: "2026-01-11",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    expect(fulfilled).toBe(1);
    const paid = await context.db.select().from(payments).where(eq(payments.invoiceId, invoice.id));
    expect(paid.reduce((sum, row) => sum + row.amountCents, 0)).toBe(600000);
    const reread = await getInvoice(context.db, org.ctx, invoice.id);
    expect(reread.invoice.status).toBe("partially_paid");
    expect(reread.balanceCents).toBe(400000);
  });

  it("rejects concurrent inserts of the same invoice number", async () => {
    const org = await createOrg(context.db, { email: "pg-unique@example.com", orgName: "PG Unique" });
    const payload = {
      number: "PG-UNIQUE-1",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      status: "sent" as const,
      lines: [{ description: "Unique", quantity: 1, unitPrice: "100", taxRatePercent: "0" }],
    };
    const results = await Promise.allSettled([
      createInvoice(context.db, org.ctx, payload),
      createInvoice(context.db, org.ctx, payload),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("seeds and restores the demo workspace without touching another organization", async () => {
    const customer = await createOrg(context.db, { email: "pg-real-customer@example.com", orgName: "Real Customer Co" });

    const seeded = await seedDemoWorkspace(context.db, { reset: true });
    expect(seeded.created).toBe(true);
    const demoUsers = await context.db
      .select({ email: users.email })
      .from(users)
      .where(sql`${users.email} in (${DEMO_OWNER_EMAIL}, ${DEMO_ADVISOR_EMAIL})`);
    expect(demoUsers).toHaveLength(2);

    const second = await seedDemoWorkspace(context.db);
    expect(second.created).toBe(false);

    const reset = await seedDemoWorkspace(context.db, { reset: true });
    expect(reset.created).toBe(true);

    const [survivor] = await context.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, customer.orgId));
    expect(survivor?.id).toBe(customer.orgId);

    const [realUser] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "pg-real-customer@example.com"));
    expect(realUser?.id).toBe(customer.userId);

    await removeDemoWorkspace(context.db);
    const remaining = await context.db.select({ id: users.id }).from(users).where(eq(users.id, customer.userId));
    expect(remaining).toHaveLength(1);
  }, 60_000);
});
