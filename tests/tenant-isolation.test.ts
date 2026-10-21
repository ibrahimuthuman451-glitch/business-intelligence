import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { createSession } from "@/lib/auth";
import { createDocument } from "@/lib/documents";
import {
  createInvoice,
  createSale,
  getInvoice,
  listInvoices,
  listSales,
  recordPayment,
  setInvoiceStatus,
} from "@/lib/finance-service";
import {
  ensureChecklist,
  getTender,
  importTender,
  listTenders,
  toggleChecklistItem,
} from "@/lib/tenders";
import { runReconciliation, getReconciliationJob } from "@/lib/reconciliation";
import { GET as downloadDocument } from "@/app/api/documents/[id]/download/route";
import { POST as previewReconciliation } from "@/app/api/reconciliation/preview/route";

let context: TestContext;
const pdf = Buffer.from("%PDF-1.7\nTenant secret bytes\n%%EOF\n", "utf8");

beforeAll(async () => {
  context = await createTestContext();
});

 afterAll(async () => {
  await context.cleanup();
});

function request(path: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: token ? { cookie: `bi_session=${token}` } : {},
  });
}

describe("cross-tenant isolation", () => {
  it("denies service-layer reads and writes across organizations", async () => {
    const a = await createOrg(context.db, { email: "iso-a@example.com", orgName: "Iso A" });
    const b = await createOrg(context.db, { email: "iso-b@example.com", orgName: "Iso B" });

    const invoice = await createInvoice(context.db, b.ctx, {
      number: "B-SECRET-1",
      issueDate: "2026-05-01",
      dueDate: "2026-06-01",
      status: "sent",
      lines: [{ description: "B only", quantity: 1, unitPrice: "450000", taxRatePercent: "0" }],
    });
    await createSale(context.db, b.ctx, {
      description: "B revenue",
      amount: "900000",
      occurredAt: "2026-05-02",
    });

    await expect(getInvoice(context.db, a.ctx, invoice.id)).rejects.toThrow(/not found/i);
    expect(await listInvoices(context.db, a.ctx)).toHaveLength(0);
    expect(await listSales(context.db, a.ctx)).toHaveLength(0);

    // Cross-tenant writes must fail rather than silently target another org.
    await expect(
      recordPayment(context.db, a.ctx, {
        invoiceId: invoice.id,
        amount: "1000",
        paidAt: "2026-05-10",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(setInvoiceStatus(context.db, a.ctx, invoice.id, "void")).rejects.toThrow(
      /not found/i,
    );

    const tender = await importTender(context.db, b.ctx, {
      reference: "B-TENDER-1",
      title: "B confidential tender",
      closesAt: "2027-01-01T10:00:00Z",
      sourceUrl: "https://example.org/notices/B-TENDER-1",
    });
    await expect(getTender(context.db, a.ctx, tender.id)).rejects.toThrow(/not found/i);
    expect((await listTenders(context.db, a.ctx)).map((row) => row.id)).not.toContain(tender.id);
    const checklist = await ensureChecklist(context.db, b.ctx, tender.id);
    await expect(
      toggleChecklistItem(context.db, a.ctx, checklist.items[0]!.id, true),
    ).rejects.toThrow(/not found/i);

    const job = await runReconciliation(context.db, b.ctx, {
      source: "ebm_sales",
      filename: "b.csv",
      bytes: Buffer.from("invoice,total\nB-SECRET-1,450000\n"),
      mapping: { invoiceNumber: "invoice", amount: "total" },
    });
    await expect(getReconciliationJob(context.db, a.ctx, job.jobId)).rejects.toThrow(/not found/i);
  });

  it("serves private file bytes only to an authorized tenant through the download route", async () => {
    const a = await createOrg(context.db, { email: "file-a@example.com", orgName: "File A" });
    const b = await createOrg(context.db, { email: "file-b@example.com", orgName: "File B" });
    const document = await createDocument(context.db, b.ctx, {
      filename: "confidential.pdf",
      declaredMimeType: "application/pdf",
      bytes: pdf,
    });

    const sessionA = await createSession(context.db, a.userId);
    const sessionB = await createSession(context.db, b.userId);
    const params = { params: Promise.resolve({ id: document.id }) };

    const anonymous = await downloadDocument(request(`/api/documents/${document.id}/download`), params);
    expect(anonymous.status).toBe(401);

    const attacker = await downloadDocument(
      request(`/api/documents/${document.id}/download`, sessionA.token),
      { params: Promise.resolve({ id: document.id }) },
    );
    expect([403, 404]).toContain(attacker.status);
    const attackerBody = Buffer.from(await attacker.arrayBuffer());
    expect(attackerBody.includes(Buffer.from("Tenant secret bytes"))).toBe(false);

    const owner = await downloadDocument(
      request(`/api/documents/${document.id}/download`, sessionB.token),
      { params: Promise.resolve({ id: document.id }) },
    );
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-disposition")).toMatch(/attachment/);
    expect(owner.headers.get("cache-control")).toContain("no-store");
    const bytes = Buffer.from(await owner.arrayBuffer());
    expect(bytes.equals(pdf)).toBe(true);
  });

  it("rejects a guessed document id and does not reveal whether it exists", async () => {
    const a = await createOrg(context.db, { email: "guess-a@example.com", orgName: "Guess A" });
    const session = await createSession(context.db, a.userId);
    const response = await downloadDocument(
      request(`/api/documents/00000000-0000-0000-0000-000000000000/download`, session.token),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Tenant secret");
  });

  it("denies the reconciliation preview API when the active org cookie points at another tenant", async () => {
    const a = await createOrg(context.db, { email: "preview-a@example.com", orgName: "Preview A" });
    const b = await createOrg(context.db, { email: "preview-b@example.com", orgName: "Preview B" });
    const session = await createSession(context.db, a.userId);

    const form = new FormData();
    form.append("file", new File(["invoice,total\nA-1,100\n"], "report.csv", { type: "text/csv" }));
    const response = await previewReconciliation(
      new NextRequest("http://localhost:3000/api/reconciliation/preview", {
        method: "POST",
        headers: { cookie: `bi_session=${session.token}; bi_org=${b.orgId}` },
        body: form,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects cross-origin preview submissions", async () => {
    const a = await createOrg(context.db, { email: "origin-a@example.com", orgName: "Origin A" });
    const session = await createSession(context.db, a.userId);
    const form = new FormData();
    form.append("file", new File(["invoice,total\nA-1,100\n"], "report.csv", { type: "text/csv" }));
    const response = await previewReconciliation(
      new NextRequest("http://localhost:3000/api/reconciliation/preview", {
        method: "POST",
        headers: { cookie: `bi_session=${session.token}`, origin: "https://evil.example" },
        body: form,
      }),
    );
    expect(response.status).toBe(422);
  });
});
