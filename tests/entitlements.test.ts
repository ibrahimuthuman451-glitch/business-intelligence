import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { readdirSync } from "node:fs";
import path from "node:path";
import { organizations, subscriptionEntitlements, tenders } from "@/db/schema";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { createSession } from "@/lib/auth";
import { createDocument } from "@/lib/documents";
import { createCustomer, createSale } from "@/lib/finance-service";
import { createMemberInvitation } from "@/lib/team";
import { setTenderSaved } from "@/lib/tenders";
import { assertEntitlement, entitlementSnapshot } from "@/lib/entitlements";
import { uploadRoot } from "@/lib/storage";
import { AppError } from "@/lib/errors";
import { buildReport, csvCell } from "@/lib/reports";
import { GET as exportReport } from "@/app/api/reports/[type]/route";

let context: TestContext;
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

async function setOverride(orgId: string, feature: string, limitValue: number | null, enabled = true) {
  await context.db.insert(subscriptionEntitlements).values({ orgId, feature, enabled, limitValue });
}

async function setPlan(orgId: string, plan: string) {
  await context.db.update(organizations).set({ plan }).where(eq(organizations.id, orgId));
}

describe("central plan entitlements", () => {
  it("enforces the document count inside a transaction and removes rejected upload bytes", async () => {
    const org = await createOrg(context.db, { email: "quota-docs@example.com", orgName: "Quota Docs" });
    await setOverride(org.orgId, "documents_count", 2);
    await createDocument(context.db, org.ctx, { filename: "one.pdf", bytes: pdf("one") });
    await createDocument(context.db, org.ctx, { filename: "two.pdf", bytes: pdf("two") });

    await expect(
      createDocument(context.db, org.ctx, { filename: "three.pdf", bytes: pdf("three") }),
    ).rejects.toMatchObject({ status: 402, code: "entitlement_limit" });

    const files = readdirSync(path.join(uploadRoot(), org.orgId));
    expect(files).toHaveLength(2);
  });

  it("enforces the storage byte limit", async () => {
    const org = await createOrg(context.db, { email: "quota-storage@example.com", orgName: "Quota Storage" });
    await setOverride(org.orgId, "document_storage_bytes", 30);
    await createDocument(context.db, org.ctx, { filename: "small.pdf", bytes: pdf("a") });
    await expect(
      createDocument(context.db, org.ctx, { filename: "second.pdf", bytes: pdf("second") }),
    ).rejects.toMatchObject({ code: "entitlement_limit" });
  });

  it("serializes concurrent uploads so a one-document limit cannot be exceeded (PostgreSQL)", async () => {
    if (context.driver !== "postgres") return;
    const org = await createOrg(context.db, { email: "quota-race@example.com", orgName: "Quota Race" });
    await setOverride(org.orgId, "documents_count", 1);
    const results = await Promise.allSettled([
      createDocument(context.db, org.ctx, { filename: "race-a.pdf", bytes: pdf("a") }),
      createDocument(context.db, org.ctx, { filename: "race-b.pdf", bytes: pdf("b") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(readdirSync(path.join(uploadRoot(), org.orgId))).toHaveLength(1);
  });

  it("counts pending invitations against the team seat limit", async () => {
    const org = await createOrg(context.db, { email: "quota-team@example.com", orgName: "Quota Team" });
    await setOverride(org.orgId, "team_members", 2);
    await createMemberInvitation(context.db, org.ctx, { email: "seat-one@example.com", role: "staff" });
    await expect(
      createMemberInvitation(context.db, org.ctx, { email: "seat-two@example.com", role: "staff" }),
    ).rejects.toMatchObject({ code: "entitlement_limit" });
  });

  it("enforces saved-opportunity limits and records the save", async () => {
    const org = await createOrg(context.db, { email: "quota-tenders@example.com", orgName: "Quota Tenders" });
    await setOverride(org.orgId, "saved_tenders", 1);
    const [one] = await context.db
      .insert(tenders)
      .values({
        orgId: org.orgId,
        reference: "QUOTA-T-1",
        title: "Quota tender one",
        closesAt: new Date(Date.now() + 5 * 86_400_000),
        sourceUrl: "https://example.org/notice/quota-1",
        provenance: "manual_import",
        verifiedAt: new Date(),
      })
      .returning({ id: tenders.id });
    const [two] = await context.db
      .insert(tenders)
      .values({
        orgId: org.orgId,
        reference: "QUOTA-T-2",
        title: "Quota tender two",
        closesAt: new Date(Date.now() + 6 * 86_400_000),
        sourceUrl: "https://example.org/notice/quota-2",
        provenance: "manual_import",
        verifiedAt: new Date(),
      })
      .returning({ id: tenders.id });

    await setTenderSaved(context.db, org.ctx, one!.id, true);
    await expect(setTenderSaved(context.db, org.ctx, two!.id, true)).rejects.toMatchObject({
      code: "entitlement_limit",
    });
  });

  it("respects disabled and numeric overrides from subscription_entitlements", async () => {
    const org = await createOrg(context.db, { email: "quota-override@example.com", orgName: "Quota Override" });
    await setOverride(org.orgId, "advanced_exports", null, false);
    await expect(assertEntitlement(context.db, org.orgId, "advanced_exports")).rejects.toBeInstanceOf(AppError);
    await setPlan(org.orgId, "demo");
    await expect(assertEntitlement(context.db, org.orgId, "advanced_exports")).rejects.toBeInstanceOf(AppError);
  });

  it("reports usage in the entitlement snapshot", async () => {
    const org = await createOrg(context.db, { email: "quota-snapshot@example.com", orgName: "Quota Snapshot" });
    await createDocument(context.db, org.ctx, { filename: "snapshot.pdf", bytes: pdf("snapshot") });
    const snapshot = await entitlementSnapshot(context.db, org.orgId);
    expect(snapshot.plan).toBe("free");
    expect(snapshot.usage.documents).toBe(1);
    expect(snapshot.usage.teamMembers).toBe(1);
    expect(snapshot.limits.advancedExports).toBe(false);
  });
});

describe("exports and organization limits", () => {
  it("blocks CSV exports on a plan without advanced exports", async () => {
    const org = await createOrg(context.db, { email: "export-free@example.com", orgName: "Export Free" });
    const session = await createSession(context.db, org.userId);
    const response = await exportReport(
      new NextRequest("http://localhost:3000/api/reports/sales", {
        headers: { cookie: `bi_session=${session.token}; bi_org=${org.orgId}` },
      }),
      { params: Promise.resolve({ type: "sales" }) },
    );
    expect(response.status).toBe(402);
    expect(await response.text()).toMatch(/advanced exports/i);
  });

  it("exports CSV for an eligible plan with formula-injection protection", async () => {
    const org = await createOrg(context.db, { email: "export-demo@example.com", orgName: "Export Demo" });
    await setPlan(org.orgId, "demo");
    const customer = await createCustomer(context.db, org.ctx, {
      name: "=cmd|' /C calc'!A0",
    });
    await createSale(context.db, org.ctx, {
      description: "Export sale",
      amount: "1000",
      occurredAt: "2026-04-01",
      customerId: customer.id,
    });

    const session = await createSession(context.db, org.userId);
    const response = await exportReport(
      new NextRequest("http://localhost:3000/api/reports/sales", {
        headers: { cookie: `bi_session=${session.token}; bi_org=${org.orgId}` },
      }),
      { params: Promise.resolve({ type: "sales" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const csv = await response.text();
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/(^|,)=cmd/);

    const report = await buildReport(context.db, org.ctx, "invoices");
    expect(report.filename).toMatch(/^invoices-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("escapes CSV cells that could become spreadsheet formulas", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@import")).toBe("'@import");
    expect(csvCell("plain, with comma")).toBe('"plain, with comma"');
    expect(csvCell('quote " inside')).toBe('"quote "" inside"');
  });

  it("limits additional organizations by the owner's plan", async () => {
    const owner = await createOrg(context.db, { email: "org-limit@example.com", orgName: "Org Limit One" });
    const { createOrganizationForUser } = await import("@/lib/organizations");
    await expect(
      createOrganizationForUser(context.db, owner.userId, { name: "Second Business", kind: "business" }),
    ).rejects.toMatchObject({ code: "entitlement_limit" });

    await setPlan(owner.orgId, "demo");
    const second = await createOrganizationForUser(context.db, owner.userId, {
      name: "Second Business",
      kind: "business",
    });
    expect(second.orgId).toBeTruthy();
  });
});
