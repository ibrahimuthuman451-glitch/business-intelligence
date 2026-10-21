import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { advisorAccess, documents } from "@/db/schema";
import { createOrg, createTestContext, reloadActor, type TestContext } from "./helpers";
import { DEMO_ADVISOR_EMAIL, DEMO_OWNER_EMAIL, DEMO_PASSWORD, seedDemoWorkspace } from "@/db/seed-demo";
import { authenticate, createSession } from "@/lib/auth";
import { authorizeOrg } from "@/lib/authz";
import { getDashboardData, createSale, createExpense, getInvoice, listInvoices } from "@/lib/finance-service";
import { listDocuments, readAuthorizedDocument } from "@/lib/documents";
import { listTenders, getTender, toggleChecklistItem } from "@/lib/tenders";
import { listTasks, completeTask } from "@/lib/tasks";
import { listNotifications } from "@/lib/notifications";
import { runReconciliation } from "@/lib/reconciliation";
import { GET as downloadDocument } from "@/app/api/documents/[id]/download/route";
import { GET as exportReport } from "@/app/api/reports/[type]/route";
import { revokeAdvisorAccess } from "@/lib/team";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
  await seedDemoWorkspace(context.db, { reset: true });
});

afterAll(async () => {
  await context.cleanup();
});

describe("controlled demo journey", () => {
  it("signs in the owner and advisor, and shows real totals from sample records", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const advisor = await authenticate(context.db, DEMO_ADVISOR_EMAIL, DEMO_PASSWORD);
    const ownerActor = await reloadActor(context.db, owner.id);
    const ownerOrg = await authorizeOrg(context.db, ownerActor, ownerActor.memberships[0]!.orgId, "finance:read");
    const dashboard = await getDashboardData(context.db, ownerOrg);
    expect(dashboard.summary.revenueCents).toBeGreaterThan(0);
    expect(dashboard.summary.outstandingCents).toBeGreaterThan(0);
    expect(dashboard.months).toHaveLength(6);

    const advisorActor = await reloadActor(context.db, advisor.id);
    const advisorOnClient = await authorizeOrg(context.db, advisorActor, ownerOrg.orgId, "finance:read");
    expect(advisorOnClient.viaAdvisorAccess).toBe(true);
    const advisorInvoices = await listInvoices(context.db, advisorOnClient);
    expect(advisorInvoices.length).toBeGreaterThan(0);
  });

  it("records a new sale and expense and recalculates totals from the database", async () => {
    const ownerUser = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const actor = await reloadActor(context.db, ownerUser.id);
    const ctx = await authorizeOrg(context.db, actor, actor.memberships[0]!.orgId, "finance:write");
    const before = (await getDashboardData(context.db, ctx)).summary.revenueCents;
    await createSale(context.db, ctx, {
      description: "[SAMPLE] Demo add-on sale",
      amount: "125000",
      occurredAt: new Date().toISOString().slice(0, 10),
    });
    await createExpense(context.db, ctx, {
      description: "[SAMPLE] Demo add-on expense",
      amount: "25000",
      occurredAt: new Date().toISOString().slice(0, 10),
      category: "transport",
    });
    const after = (await getDashboardData(context.db, ctx)).summary;
    expect(after.revenueCents).toBe(before + 125000);
    expect(after.expensesCents).toBeGreaterThan(0);
  });

  it("lets the advisor request a document, the owner upload it, and the advisor review it", async () => {
    const ownerUser = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const advisorUser = await authenticate(context.db, DEMO_ADVISOR_EMAIL, DEMO_PASSWORD);
    const ownerActor = await reloadActor(context.db, ownerUser.id);
    const advisorActor = await reloadActor(context.db, advisorUser.id);
    const ownerCtx = await authorizeOrg(context.db, ownerActor, ownerActor.memberships[0]!.orgId, "documents:write");
    const advisorCtx = await authorizeOrg(context.db, advisorActor, ownerCtx.orgId, "documents:write");

    const ownerNotifications = await listNotifications(context.db, ownerUser.id, ownerCtx.orgId);
    expect(ownerNotifications.some((item) => item.type === "documents")).toBe(true);

    const documentsBefore = await listDocuments(context.db, ownerCtx.orgId);
    expect(documentsBefore.length).toBeGreaterThanOrEqual(2);
    const target = documentsBefore.find((document) => document.originalFilename.endsWith(".pdf"));
    expect(target).toBeTruthy();

    const read = await readAuthorizedDocument(context.db, advisorCtx, target!.id);
    expect(read.bytes.subarray(0, 4).toString()).toBe("%PDF");

    const { reviewDocument } = await import("@/lib/documents");
    await reviewDocument(context.db, advisorCtx, target!.id, {
      status: "approved",
      notes: "Synthetic demo review: matched to the sample bank statement.",
    });
    const [updated] = await context.db.select().from(documents).where(eq(documents.id, target!.id));
    expect(updated?.status).toBe("approved");
    expect(updated?.reviewNotes).toContain("Synthetic demo review");
  });

  it("runs a sample reconciliation with a traceable finding", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const actor = await reloadActor(context.db, owner.id);
    const ctx = await authorizeOrg(context.db, actor, actor.memberships[0]!.orgId, "recon:write");
    const result = await runReconciliation(context.db, ctx, {
      source: "ebm_sales",
      filename: "demo-sales.csv",
      bytes: Buffer.from(
        "Invoice Number,Total\nSAMPLE-INV-001,1466000\nSAMPLE-INV-DEMO-MISSING,50000\n",
      ),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total" },
    });
    expect(result.rowsMatched).toBe(1);
    expect(result.findingsCount).toBe(1);
  });

  it("shows a sample tender with provenance and completes bid-readiness items", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const actor = await reloadActor(context.db, owner.id);
    const ctx = await authorizeOrg(context.db, actor, actor.memberships[0]!.orgId, "tenders:write");
    const tenders = await listTenders(context.db, ctx, { status: "all" });
    const sample = tenders.find((tender) => tender.reference === "SAMPLE-2026-002");
    expect(sample?.provenance).toBe("sample");
    const detail = await getTender(context.db, ctx, sample!.id);
    expect(detail.checklist?.items.length).toBeGreaterThan(0);
    for (const item of detail.checklist!.items) {
      if (!item.done) await toggleChecklistItem(context.db, ctx, item.id, true);
    }
    const refreshed = await getTender(context.db, ctx, sample!.id);
    expect(refreshed.checklist?.status).toBe("ready");
  });

  it("shows upcoming tasks and completes one", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const actor = await reloadActor(context.db, owner.id);
    const ctx = await authorizeOrg(context.db, actor, actor.memberships[0]!.orgId, "finance:write");
    const upcoming = await listTasks(context.db, ctx, { status: "all" });
    expect(upcoming.length).toBeGreaterThanOrEqual(2);
    await completeTask(context.db, ctx, upcoming[0]!.id);
    const remaining = await listTasks(context.db, ctx, { status: "open" });
    expect(remaining.map((task) => task.id)).not.toContain(upcoming[0]!.id);
  });

  it("downloads a report and blocks a different organization from the same resources", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const ownerActor = await reloadActor(context.db, owner.id);
    const orgId = ownerActor.memberships[0]!.orgId;
    const session = await createSession(context.db, owner.id);
    const report = await exportReport(
      new NextRequest("http://localhost:3000/api/reports/sales", {
        headers: { cookie: `bi_session=${session.token}; bi_org=${orgId}` },
      }),
      { params: Promise.resolve({ type: "sales" }) },
    );
    expect(report.status).toBe(200);
    expect(report.headers.get("x-report-sample")).toBe("true");
    const csv = await report.text();
    expect(csv).toContain("[SAMPLE]");

    const outsider = await createOrg(context.db, { email: "demo-outsider@example.com", orgName: "Demo Outsider" });
    const outsiderSession = await createSession(context.db, outsider.userId);
    const [doc] = await context.db.select({ id: documents.id }).from(documents).where(eq(documents.orgId, orgId)).limit(1);
    const denied = await downloadDocument(
      new NextRequest(`http://localhost:3000/api/documents/${doc!.id}/download`, {
        headers: { cookie: `bi_session=${outsiderSession.token}; bi_org=${orgId}` },
      }),
      { params: Promise.resolve({ id: doc!.id }) },
    );
    expect([403, 404]).toContain(denied.status);
    const deniedReport = await exportReport(
      new NextRequest("http://localhost:3000/api/reports/invoices", {
        headers: { cookie: `bi_session=${outsiderSession.token}; bi_org=${orgId}` },
      }),
      { params: Promise.resolve({ type: "invoices" }) },
    );
    expect(deniedReport.status).toBe(403);
    await expect(
      getInvoice(
        context.db,
        await authorizeOrg(context.db, await reloadActor(context.db, outsider.userId), outsider.orgId, "finance:read"),
        (await listInvoices(context.db, await authorizeOrg(context.db, await reloadActor(context.db, owner.id), orgId, "finance:read")))[0]!.id,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("stops advisor access immediately after revocation", async () => {
    const owner = await authenticate(context.db, DEMO_OWNER_EMAIL, DEMO_PASSWORD);
    const advisor = await authenticate(context.db, DEMO_ADVISOR_EMAIL, DEMO_PASSWORD);
    const ownerActor = await reloadActor(context.db, owner.id);
    const orgId = ownerActor.memberships[0]!.orgId;
    const ownerCtx = await authorizeOrg(context.db, ownerActor, orgId, "team:manage");
    const [grant] = await context.db
      .select()
      .from(advisorAccess)
      .where(and(eq(advisorAccess.clientOrgId, orgId), eq(advisorAccess.status, "active")))
      .limit(1);
    expect(grant).toBeTruthy();
    const [doc] = await context.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.orgId, orgId))
      .limit(1);
    const advisorSession = await createSession(context.db, advisor.id);
    const before = await downloadDocument(
      new NextRequest(`http://localhost:3000/api/documents/${doc!.id}/download`, {
        headers: { cookie: `bi_session=${advisorSession.token}` },
      }),
      { params: Promise.resolve({ id: doc!.id }) },
    );
    expect(before.status).toBe(200);
    await revokeAdvisorAccess(context.db, ownerCtx, grant!.id);
    const after = await downloadDocument(
      new NextRequest(`http://localhost:3000/api/documents/${doc!.id}/download`, {
        headers: { cookie: `bi_session=${advisorSession.token}` },
      }),
      { params: Promise.resolve({ id: doc!.id }) },
    );
    expect(after.status).toBe(403);
    await expect(
      authorizeOrg(context.db, await reloadActor(context.db, advisor.id), orgId, "finance:read"),
    ).rejects.toThrow(/do not have access/i);
  });
});
