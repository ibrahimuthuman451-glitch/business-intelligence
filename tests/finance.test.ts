import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeFinancialSummary,
  deriveInvoiceStatus,
} from "@/lib/finance";
import {
  computeInvoiceTotals,
  formatMinor,
  MoneyError,
  parseMoneyToMinor,
} from "@/lib/money";
import {
  createInvoice,
  createSale,
  getDashboardData,
  getInvoice,
  listInvoices,
  recordPayment,
} from "@/lib/finance-service";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import { ValidationError } from "@/lib/errors";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("money parsing", () => {
  it("stores integer minor units and respects zero-decimal currencies", () => {
    expect(parseMoneyToMinor("1,250", "RWF")).toBe(1250);
    expect(parseMoneyToMinor("1 250", "RWF")).toBe(1250);
    expect(parseMoneyToMinor("1250.50", "USD")).toBe(125050);
    expect(parseMoneyToMinor("0.05", "USD")).toBe(5);
    expect(() => parseMoneyToMinor("1250.50", "RWF")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("abc", "RWF")).toThrow(MoneyError);
    expect(() => parseMoneyToMinor("-5", "RWF")).toThrow(MoneyError);
    expect(formatMinor(125050, "USD")).toBe("1,250.50");
  });

  it("computes line totals with rounded tax", () => {
    const totals = computeInvoiceTotals([
      { quantity: 3, unitPriceCents: 3333, taxRateBp: 1800 },
      { quantity: 1, unitPriceCents: 100, taxRateBp: 0 },
    ]);
    expect(totals.subtotalCents).toBe(10099);
    expect(totals.taxCents).toBe(1800); // 5999.4 -> 1800 rounded
    expect(totals.totalCents).toBe(11899);
    expect(() => computeInvoiceTotals([])).toThrow(MoneyError);
    expect(() => computeInvoiceTotals([{ quantity: 0, unitPriceCents: 10, taxRateBp: 0 }])).toThrow(MoneyError);
  });
});

describe("invoice lifecycle", () => {
  it("derives totals on the server and updates status from payments", async () => {
    const org = await createOrg(context.db, { email: "finance@example.com", orgName: "Finance Co" });
    const created = await createInvoice(context.db, org.ctx, {
      number: "INV-TEST-001",
      issueDate: "2026-06-01",
      dueDate: "2026-06-30",
      status: "sent",
      lines: [
        { description: "Consulting", quantity: 2, unitPrice: "500000", taxRatePercent: "18" },
        { description: "Travel", quantity: 1, unitPrice: "100000", taxRatePercent: "0" },
      ],
    });

    let invoice = await getInvoice(context.db, org.ctx, created.id);
    expect(invoice.invoice.subtotalCents).toBe(1100000);
    expect(invoice.invoice.taxCents).toBe(180000);
    expect(invoice.invoice.totalCents).toBe(1280000);
    expect(invoice.balanceCents).toBe(1280000);
    expect(invoice.items).toHaveLength(2);

    await recordPayment(context.db, org.ctx, {
      invoiceId: created.id,
      amount: "280000",
      paidAt: "2026-06-10",
    });
    invoice = await getInvoice(context.db, org.ctx, created.id);
    expect(invoice.invoice.status).toBe("partially_paid");
    expect(invoice.balanceCents).toBe(1000000);

    await expect(
      recordPayment(context.db, org.ctx, {
        invoiceId: created.id,
        amount: "1000001",
        paidAt: "2026-06-11",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await recordPayment(context.db, org.ctx, {
      invoiceId: created.id,
      amount: "1000000",
      paidAt: "2026-06-12",
    });
    invoice = await getInvoice(context.db, org.ctx, created.id);
    expect(invoice.invoice.status).toBe("paid");
    expect(invoice.balanceCents).toBe(0);
    expect(invoice.payments).toHaveLength(2);
  });

  it("rejects duplicate invoice numbers within an organization", async () => {
    const org = await createOrg(context.db, { email: "dupe-invoice@example.com", orgName: "Dupe Invoice Co" });
    const payload = {
      number: "INV-DUPE-1",
      issueDate: "2026-06-01",
      dueDate: "2026-06-30",
      lines: [{ description: "Service", quantity: 1, unitPrice: "1000", taxRatePercent: "0" }],
    };
    await createInvoice(context.db, org.ctx, payload);
    await expect(createInvoice(context.db, org.ctx, payload)).rejects.toThrow(/already exists/i);
  });

  it("does not allow another organization to read an invoice by id", async () => {
    const a = await createOrg(context.db, { email: "fin-a@example.com", orgName: "Fin A" });
    const b = await createOrg(context.db, { email: "fin-b@example.com", orgName: "Fin B" });
    const created = await createInvoice(context.db, b.ctx, {
      issueDate: "2026-06-01",
      dueDate: "2026-06-30",
      lines: [{ description: "Secret", quantity: 1, unitPrice: "500", taxRatePercent: "0" }],
    });
    await expect(getInvoice(context.db, a.ctx, created.id)).rejects.toThrow(/not found/i);
    expect(await listInvoices(context.db, a.ctx)).toHaveLength(0);
  });
});

describe("financial summary", () => {
  it("computes revenue, ageing and outstanding balances from records", () => {
    const today = new Date("2026-06-15T00:00:00Z");
    const summary = computeFinancialSummary(
      [
        { amountCents: 1_000_000, taxCents: 180_000, currency: "RWF" },
        { amountCents: 500_000, taxCents: 90_000, currency: "RWF" },
      ],
      [{ amountCents: 300_000, taxCents: 54_000 }],
      [
        { totalCents: 400_000, status: "sent", dueDate: "2026-07-10", currency: "RWF" },
        { totalCents: 200_000, status: "sent", dueDate: "2026-06-01", currency: "RWF" },
        { totalCents: 100_000, status: "sent", dueDate: "2026-03-01", currency: "RWF" },
        { totalCents: 999_999, status: "draft", dueDate: "2026-01-01", currency: "RWF" },
      ],
      [{ amountCents: 150_000 }],
      today,
    );

    expect(summary.revenueCents).toBe(1_500_000);
    expect(summary.expensesCents).toBe(300_000);
    expect(summary.grossProfitCents).toBe(1_200_000);
    expect(summary.netTaxCents).toBe(216_000);
    expect(summary.invoicedCents).toBe(700_000);
    expect(summary.collectedCents).toBe(150_000);
    expect(summary.outstandingCents).toBe(550_000);
    // Payments allocate oldest-first: 100k clears the March invoice, 50k reduces June to 150k.
    expect(summary.overdueCents).toBe(150_000);
    expect(summary.aging.current).toBe(400_000);
    expect(summary.aging.d1_30).toBe(150_000);
    expect(summary.aging.d90_plus).toBe(0);
    expect(summary.unpaidInvoiceCount).toBe(2);
  });

  it("never marks a draft invoice overdue", () => {
    expect(
      deriveInvoiceStatus({
        current: "draft",
        totalCents: 100,
        paidCents: 0,
        dueDate: "2020-01-01",
        today: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toBe("draft");
    expect(
      deriveInvoiceStatus({
        current: "sent",
        totalCents: 100,
        paidCents: 100,
        dueDate: "2020-01-01",
        today: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toBe("paid");
  });

  it("feeds the dashboard only with the authorized organization's records", async () => {
    const a = await createOrg(context.db, { email: "dash-a@example.com", orgName: "Dash A" });
    const b = await createOrg(context.db, { email: "dash-b@example.com", orgName: "Dash B" });
    await createSale(context.db, a.ctx, {
      description: "A sale",
      amount: "100000",
      occurredAt: "2026-06-01",
    });
    await createSale(context.db, b.ctx, {
      description: "B sale",
      amount: "999000",
      occurredAt: "2026-06-01",
    });

    const dashboardA = await getDashboardData(context.db, a.ctx);
    const dashboardB = await getDashboardData(context.db, b.ctx);
    expect(dashboardA.summary.revenueCents).toBe(100000);
    expect(dashboardB.summary.revenueCents).toBe(999000);
  });
});
