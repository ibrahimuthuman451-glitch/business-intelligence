import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { documents, invoices, organizations, reconciliationJobs, sales } from "@/db/schema";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { createExpense, createInvoice } from "@/lib/finance-service";
import {
  getReconciliationJob,
  parseTabularFile,
  runReconciliation,
  suggestMapping,
} from "@/lib/reconciliation";
import { parseXlsx } from "@/lib/xlsx";
import { ValidationError } from "@/lib/errors";

let context: TestContext;
const fixture = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures", name));

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

async function usdOrg(email: string, name: string) {
  const org = await createOrg(context.db, { email, orgName: name });
  await context.db
    .update(organizations)
    .set({ defaultCurrency: "USD" })
    .where(eq(organizations.id, org.orgId));
  return org;
}

async function invoiceFor(org: Awaited<ReturnType<typeof createOrg>>, number: string, amount: string, issueDate: string) {
  return createInvoice(context.db, org.ctx, {
    number,
    issueDate,
    dueDate: issueDate,
    status: "sent",
    lines: [{ description: `Synthetic ${number}`, quantity: 1, unitPrice: amount, taxRatePercent: "0" }],
  });
}

describe("XLSX and CSV fixtures", () => {
  it("parses the generated OOXML workbook", async () => {
    const table = await parseXlsx(fixture("sales-standard.xlsx"));
    expect(table.headers).toEqual(["Invoice Number", "Total", "Date", "Customer"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(["XLSX-1001", "118000", "2026-03-02", "Sample Customer A"]);
  });

  it("suggests mappings for English and French headers", () => {
    expect(suggestMapping(["Invoice Number", "Total", "Date"])).toMatchObject({
      invoiceNumber: "Invoice Number",
      amount: "Total",
      date: "Date",
    });
    expect(suggestMapping(["Facture", "Montant", "Date"])).toMatchObject({
      invoiceNumber: "Facture",
      amount: "Montant",
      date: "Date",
    });
  });

  it("reconciles the standard CSV fixture end to end", async () => {
    const org = await createOrg(context.db, { email: "csv-standard@example.com", orgName: "CSV Standard" });
    await invoiceFor(org, "CSV-1001", "118000", "2026-03-02");
    await invoiceFor(org, "CSV-1002", "59000", "2026-03-03");
    await invoiceFor(org, "CSV-1003", "250000", "2026-03-04");

    const before = await context.db.select({ total: count() }).from(sales).where(eq(sales.orgId, org.orgId));
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "sales-standard.csv",
      bytes: fixture("sales-standard.csv"),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total", date: "Date" },
    });
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsMatched).toBe(3);
    expect(result.findingsCount).toBe(0);
    const after = await context.db.select({ total: count() }).from(sales).where(eq(sales.orgId, org.orgId));
    expect(after[0]?.total).toBe(before[0]?.total);
  });

  it("reconciles the XLSX fixture end to end", async () => {
    const org = await createOrg(context.db, { email: "xlsx-standard@example.com", orgName: "XLSX Standard" });
    await invoiceFor(org, "XLSX-1001", "118000", "2026-03-02");
    await invoiceFor(org, "XLSX-1002", "59000", "2026-03-03");
    await invoiceFor(org, "XLSX-1003", "250000", "2026-03-04");
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "sales-standard.xlsx",
      bytes: fixture("sales-standard.xlsx"),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total", date: "Date" },
    });
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsMatched).toBe(3);
    const { job } = await getReconciliationJob(context.db, org.ctx, result.jobId);
    expect(job.format).toBe("xlsx");
  });

  it("handles semicolons, decimal commas, spaces and DD/MM/YYYY dates in a USD organization", async () => {
    const org = await usdOrg("csv-eu@example.com", "CSV EU");
    await invoiceFor(org, "CSV-EU-1", "1180.00", "2026-03-02");
    await invoiceFor(org, "CSV-EU-2", "1500.50", "2026-03-03");
    await invoiceFor(org, "CSV-EU-3", "900.00", "2026-03-04");
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "sales-eu.csv",
      bytes: fixture("sales-eu.csv"),
      mapping: { invoiceNumber: "Facture", amount: "Montant", date: "Date" },
    });
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsMatched).toBe(3);
    expect(result.findingsCount).toBe(0);
  });

  it("parses the EU XLSX fixture with blank and decimal-comma cells", async () => {
    const table = await parseTabularFile({ filename: "sales-eu.xlsx", bytes: fixture("sales-eu.xlsx") });
    expect(table.headers).toEqual(["Facture", "Montant", "Date"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]?.[0]).toBe("");
  });

  it("produces traceable findings for a messy file", async () => {
    const org = await createOrg(context.db, { email: "csv-messy@example.com", orgName: "CSV Messy" });
    await invoiceFor(org, "CSV-M-1", "118000", "2026-03-02");
    await invoiceFor(org, "CSV-M-3", "5000", "2026-03-04");
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "sales-messy.csv",
      bytes: fixture("sales-messy.csv"),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total", date: "Date" },
    });
    expect(result.rowsTotal).toBe(5);
    expect(result.rowsMatched).toBe(1);
    const { findings } = await getReconciliationJob(context.db, org.ctx, result.jobId);
    const codes = findings.map((finding) => finding.code).sort();
    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "INVALID_AMOUNT",
        "AMOUNT_MISMATCH",
        "MISSING_REFERENCE",
      ]),
    );
    const mismatch = findings.find((finding) => finding.code === "AMOUNT_MISMATCH");
    expect(mismatch?.rawRow).toMatchObject({ "Invoice Number": "CSV-M-3", Total: "-5000" });
    expect(mismatch?.expectedCents).toBe(5000);
    expect(mismatch?.actualCents).toBe(-5000);
  });

  it("reconciles purchases using the supplier fixture", async () => {
    const org = await createOrg(context.db, { email: "purchases@example.com", orgName: "Purchases Co" });
    await createExpense(context.db, org.ctx, {
      description: "Synthetic purchase 1",
      amount: "45000",
      occurredAt: "2026-03-01",
      reference: "PUR-2001",
    });
    await createExpense(context.db, org.ctx, {
      description: "Synthetic purchase 2",
      amount: "12000",
      occurredAt: "2026-03-02",
      reference: "PUR-2002",
    });
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_purchases",
      filename: "purchases-standard.csv",
      bytes: fixture("purchases-standard.csv"),
      mapping: { invoiceNumber: "Supplier Ref", amount: "Amount" },
    });
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsMatched).toBe(2);
    expect(result.findingsCount).toBe(1);
    const { findings } = await getReconciliationJob(context.db, org.ctx, result.jobId);
    expect(findings[0]?.code).toBe("MISSING_IN_SYSTEM");
    expect(findings[0]?.invoiceNumber).toBe("PUR-9999");
  });

  it("rejects malformed CSV and unsupported or corrupt XLSX without creating a job", async () => {
    const org = await createOrg(context.db, { email: "malformed@example.com", orgName: "Malformed Co" });
    const before = await context.db
      .select({ total: count() })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.orgId, org.orgId));

    await expect(
      runReconciliation(context.db, org.ctx, {
        source: "ebm_sales",
        filename: "malformed.csv",
        bytes: fixture("malformed.csv"),
        mapping: { invoiceNumber: "Invoice Number", amount: "Total" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      parseTabularFile({ filename: "sales-standard.xlsx", bytes: Buffer.from("not a zip") }),
    ).rejects.toBeInstanceOf(ValidationError);

    const after = await context.db
      .select({ total: count() })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.orgId, org.orgId));
    expect(after[0]?.total).toBe(before[0]?.total);
  });

  it("handles a 500-row file and leaves financial records untouched", async () => {
    const org = await createOrg(context.db, { email: "large-file@example.com", orgName: "Large File" });
    const lines = ["Invoice Number,Total"];
    for (let index = 0; index < 500; index += 1) {
      lines.push(`LARGE-${index},${1000 + index}`);
    }
    const before = {
      invoices: (await context.db.select({ total: count() }).from(invoices).where(eq(invoices.orgId, org.orgId)))[0]?.total,
      documents: (await context.db.select({ total: count() }).from(documents).where(eq(documents.orgId, org.orgId)))[0]?.total,
    };
    const started = Date.now();
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "large.csv",
      bytes: Buffer.from(lines.join("\n")),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total" },
    });
    expect(result.rowsTotal).toBe(500);
    expect(result.findingsCount).toBe(500);
    expect(Date.now() - started).toBeLessThan(20_000);
    const after = {
      invoices: (await context.db.select({ total: count() }).from(invoices).where(eq(invoices.orgId, org.orgId)))[0]?.total,
      documents: (await context.db.select({ total: count() }).from(documents).where(eq(documents.orgId, org.orgId)))[0]?.total,
    };
    expect(after).toEqual(before);
  }, 30_000);
});
