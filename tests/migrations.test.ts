import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { customers, invoices, memberships } from "@/db/schema";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

 afterAll(async () => {
  await context.cleanup();
});

const REQUIRED_TABLES = [
  "users",
  "organizations",
  "memberships",
  "business_profiles",
  "advisor_access",
  "invitations",
  "customers",
  "suppliers",
  "sales",
  "expenses",
  "invoices",
  "invoice_items",
  "payments",
  "documents",
  "document_requests",
  "tasks",
  "notifications",
  "tender_sources",
  "tenders",
  "tender_matches",
  "bid_checklists",
  "bid_checklist_items",
  "reconciliation_jobs",
  "reconciliation_findings",
  "audit_events",
  "subscription_entitlements",
  "sessions",
  "verification_tokens",
  "email_outbox",
  "rate_limits",
  "notification_preferences",
  "job_runs",
];

describe("migrations", () => {
  it("creates every required table on a fresh database", async () => {
    const result = (await context.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )) as unknown;
    const rows = Array.isArray(result)
      ? (result as { table_name: string }[])
      : ((result as { rows: { table_name: string }[] }).rows ?? []);
    const names = rows.map((row) => row.table_name);
    for (const table of REQUIRED_TABLES) expect(names).toContain(table);
  });

  it("enforces foreign keys, enums and check constraints at the database level", async () => {
    await expect(
      context.db.insert(memberships).values({
        orgId: "00000000-0000-0000-0000-000000000000",
        userId: "00000000-0000-0000-0000-000000000001",
        role: "owner",
      }),
    ).rejects.toThrow();

    const org = await createOrg(context.db, { email: "constraints@example.com", orgName: "Constraint Co" });
    await expect(
      context.db.execute(
        sql`insert into memberships (id, org_id, user_id, role, status) values ('m-bad', ${org.orgId}, ${org.userId}, 'superuser', 'active')`,
      ),
    ).rejects.toThrow();

    await expect(
      context.db.execute(
        sql`insert into sales (id, org_id, description, amount_cents, occurred_at) values ('s-neg', ${org.orgId}, 'Negative', -5, '2026-01-01')`,
      ),
    ).rejects.toThrow();

    await context.db.insert(customers).values({ orgId: org.orgId, name: "Constraint Customer" });
    const [customer] = await context.db.select().from(customers).limit(1);
    await context.db.insert(invoices).values({
      orgId: org.orgId,
      customerId: customer!.id,
      number: "CONSTRAINT-1",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      totalCents: 100,
      status: "sent",
    });
    await expect(
      context.db.insert(invoices).values({
        orgId: org.orgId,
        number: "CONSTRAINT-1",
        issueDate: "2026-01-01",
        dueDate: "2026-02-01",
        totalCents: 100,
        status: "sent",
      }),
    ).rejects.toThrow();
  });

  it("rejects a source URL that is not http(s) through the check constraint", async () => {
    await expect(
      context.db.execute(
        sql`insert into tenders (id, reference, title, closes_at, source_url, provenance) values ('t-bad', 'BAD', 'Bad URL', now(), 'ftp://example.org/file', 'manual_import')`,
      ),
    ).rejects.toThrow();
  });
});
