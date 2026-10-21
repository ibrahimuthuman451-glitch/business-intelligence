import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsvTable, parseAmountCell, rowsToObjects } from "@/lib/csv";
import {
  parseDateCell,
  reconcilePurchaseRows,
  reconcileSalesRows,
  toMinorAmount,
} from "@/lib/reconciliation-engine";
import {
  getReconciliationJob,
  parseTabularFile,
  runReconciliation,
  suggestMapping,
} from "@/lib/reconciliation";
import { createInvoice, createExpense } from "@/lib/finance-service";
import { reviewFinding } from "@/lib/reconciliation";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { ValidationError } from "@/lib/errors";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("tabular parsing", () => {
  it("parses quoted CSV fields, embedded commas and newlines", () => {
    const table = parseCsvTable(
      'Invoice No,Amount,Date\n"INV-1","1,250.00",2026-03-01\nINV-2,"2,000",05/03/2026\n',
    );
    expect(table.headers).toEqual(["Invoice No", "Amount", "Date"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.[1]).toBe("1,250.00");
    expect(table.rows[1]?.[2]).toBe("05/03/2026");
    expect(parseAmountCell("1,250.00")).toBe(1250);
    expect(parseDateCell("05/03/2026")).toBe("2026-03-05");
    expect(parseDateCell("2026-03-05")).toBe("2026-03-05");
    expect(toMinorAmount("1,250", "RWF")).toBe(1250);
    expect(toMinorAmount("1,250.50", "USD")).toBe(125050);
  });

  it("suggests a mapping from common headers", () => {
    expect(suggestMapping(["Invoice Number", "Total", "Invoice Date"])).toEqual({
      invoiceNumber: "Invoice Number",
      amount: "Total",
      date: "Invoice Date",
    });
  });
});

describe("reconciliation engine", () => {
  it("finds missing, mismatched and duplicate sales rows", () => {
    const rows = rowsToObjects(
      ["invoice", "total"],
      [
        ["INV-1", "118000"],
        ["INV-2", "99000"],
        ["INV-MISSING", "50000"],
        ["INV-1", "118000"],
        ["INV-3", "not-a-number"],
      ],
    );
    const invoices = new Map([
      ["INV-1", { number: "INV-1", totalCents: 118000, issueDate: "2026-03-01" }],
      ["INV-2", { number: "INV-2", totalCents: 100000, issueDate: "2026-03-02" }],
      ["INV-3", { number: "INV-3", totalCents: 5000, issueDate: "2026-03-03" }],
    ]);

    const result = reconcileSalesRows(rows, { invoiceNumber: "invoice", amount: "total" }, invoices, "RWF");
    expect(result.rowsMatched).toBe(1);
    const codes = result.outcomes.flatMap((outcome) => outcome.findings).map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining(["AMOUNT_MISMATCH", "MISSING_IN_SYSTEM", "DUPLICATE_ROW", "INVALID_AMOUNT"]),
    );
    const mismatch = result.outcomes.flatMap((outcome) => outcome.findings).find((finding) => finding.code === "AMOUNT_MISMATCH");
    expect(mismatch?.expectedCents).toBe(100000);
    expect(mismatch?.actualCents).toBe(99000);
  });

  it("matches purchases by supplier reference and amount", () => {
    const rows = rowsToObjects(
      ["Reference", "Amount"],
      [
        ["SUP-1", "45000"],
        ["SUP-2", "12000"],
      ],
    );
    const expenses = new Map([
      ["SUP-1", { reference: "SUP-1", amountCents: 45000, occurredAt: "2026-03-01" }],
    ]);
    const result = reconcilePurchaseRows(rows, { invoiceNumber: "Reference", amount: "Amount" }, expenses, "RWF");
    expect(result.rowsMatched).toBe(1);
    expect(result.outcomes[1]?.findings[0]?.code).toBe("MISSING_IN_SYSTEM");
  });
});

describe("reconciliation jobs", () => {
  it("stores traceable findings with the raw row and supports human review", async () => {
    const org = await createOrg(context.db, { email: "recon@example.com", orgName: "Recon Co" });
    await createInvoice(context.db, org.ctx, {
      number: "RECON-1",
      issueDate: "2026-03-01",
      dueDate: "2026-03-31",
      status: "sent",
      lines: [{ description: "Services", quantity: 1, unitPrice: "100000", taxRatePercent: "18" }],
    });

    const csv = [
      "Invoice Number,Total,Date",
      "RECON-1,118000,2026-03-02",
      "RECON-2,50000,2026-03-03",
      "RECON-1,118000,2026-03-02",
    ].join("\n");

    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_sales",
      filename: "sales.csv",
      bytes: Buffer.from(csv),
      mapping: { invoiceNumber: "Invoice Number", amount: "Total", date: "Date" },
    });
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsMatched).toBe(1);
    expect(result.findingsCount).toBe(2);

    const { job, findings } = await getReconciliationJob(context.db, org.ctx, result.jobId);
    expect(job.status).toBe("completed");
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["MISSING_IN_SYSTEM", "DUPLICATE_ROW"]),
    );
    const missing = findings.find((finding) => finding.code === "MISSING_IN_SYSTEM");
    expect(missing?.rowNumber).toBe(3);
    expect(missing?.rawRow).toMatchObject({ "Invoice Number": "RECON-2", Total: "50000" });

    await reviewFinding(context.db, org.ctx, missing!.id, {
      status: "accepted",
      note: "Invoice was issued in the previous period",
    });
    const after = await getReconciliationJob(context.db, org.ctx, result.jobId);
    const reviewed = after.findings.find((finding) => finding.id === missing!.id);
    expect(reviewed?.status).toBe("accepted");
    expect(reviewed?.resolutionNote).toContain("previous period");
    expect(reviewed?.reviewedAt).toBeInstanceOf(Date);
  });

  it("matches purchase imports against expenses", async () => {
    const org = await createOrg(context.db, { email: "recon-purchases@example.com", orgName: "Recon Purchases" });
    await createExpense(context.db, org.ctx, {
      description: "Office supplies",
      amount: "45000",
      occurredAt: "2026-03-01",
      reference: "SUP-100",
    });
    const result = await runReconciliation(context.db, org.ctx, {
      source: "ebm_purchases",
      filename: "purchases.csv",
      bytes: Buffer.from("Ref,Amount\nSUP-100,45000\nSUP-200,1000\n"),
      mapping: { invoiceNumber: "Ref", amount: "Amount" },
    });
    expect(result.rowsMatched).toBe(1);
    expect(result.findingsCount).toBe(1);
  });

  it("rejects a mapping that does not exist in the file before creating a job", async () => {
    const org = await createOrg(context.db, { email: "recon-badmap@example.com", orgName: "Recon Bad Map" });
    await expect(
      runReconciliation(context.db, org.ctx, {
        source: "ebm_sales",
        filename: "bad.csv",
        bytes: Buffer.from("a,b\n1,2\n"),
        mapping: { invoiceNumber: "Invoice", amount: "Amount" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects unsupported file formats", async () => {
    await expect(
      parseTabularFile({ filename: "report.pdf", bytes: Buffer.from("%PDF") }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
