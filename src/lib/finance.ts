export type SaleLike = { amountCents: number; taxCents: number; currency: string };
export type ExpenseLike = { amountCents: number; taxCents: number };
export type InvoiceLike = {
  totalCents: number;
  status: string;
  dueDate: string;
  currency: string;
};
export type PaymentLike = { amountCents: number };

export type AgingBuckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };

export type FinancialSummary = {
  revenueCents: number;
  expensesCents: number;
  grossProfitCents: number;
  taxCollectedCents: number;
  taxPaidCents: number;
  netTaxCents: number;
  invoicedCents: number;
  collectedCents: number;
  outstandingCents: number;
  overdueCents: number;
  invoiceCount: number;
  unpaidInvoiceCount: number;
  aging: AgingBuckets;
};

const OPEN_INVOICE_STATUSES = new Set(["sent", "partially_paid", "paid", "overdue"]);

function daysBetween(from: string, to: Date): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000);
}

/**
 * Derives invoice status from payments and due date. Financial state is always
 * computed from records, never trusted from the client.
 */
export function deriveInvoiceStatus(input: {
  current: string;
  totalCents: number;
  paidCents: number;
  dueDate: string;
  today?: Date;
}): "draft" | "sent" | "partially_paid" | "paid" | "overdue" | "void" {
  if (input.current === "draft" || input.current === "void") return input.current;
  if (input.totalCents > 0 && input.paidCents >= input.totalCents) return "paid";
  if (input.paidCents > 0) return "partially_paid";
  const today = input.today ?? new Date();
  if (input.dueDate < today.toISOString().slice(0, 10)) return "overdue";
  return "sent";
}

export function computeFinancialSummary(
  salesRows: SaleLike[],
  expenseRows: ExpenseLike[],
  invoiceRows: InvoiceLike[],
  paymentRows: PaymentLike[],
  today: Date = new Date(),
): FinancialSummary {
  const revenueCents = salesRows.reduce((sum, row) => sum + row.amountCents, 0);
  const taxCollectedCents = salesRows.reduce((sum, row) => sum + row.taxCents, 0);
  const expensesCents = expenseRows.reduce((sum, row) => sum + row.amountCents, 0);
  const taxPaidCents = expenseRows.reduce((sum, row) => sum + row.taxCents, 0);

  const openInvoices = invoiceRows.filter((row) => OPEN_INVOICE_STATUSES.has(row.status));
  const invoicedCents = openInvoices.reduce((sum, row) => sum + row.totalCents, 0);
  // Payments only count against real (non-draft, non-void) invoices.
  const collectedCents = paymentRows.reduce((sum, row) => sum + row.amountCents, 0);
  const outstandingCents = Math.max(invoicedCents - collectedCents, 0);

  const aging: AgingBuckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let overdueCents = 0;
  let unpaidInvoiceCount = 0;

  // Payments are allocated against invoices oldest-first below.
  let remainingPayments = collectedCents;
  const sorted = [...invoiceRows]
    .filter((row) => OPEN_INVOICE_STATUSES.has(row.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  for (const invoice of sorted) {
    const applied = Math.min(remainingPayments, invoice.totalCents);
    remainingPayments -= applied;
    const balance = invoice.totalCents - applied;
    if (balance > 0) unpaidInvoiceCount += 1;

    const overdueDays = daysBetween(invoice.dueDate, today);
    if (overdueDays <= 0) {
      aging.current += balance;
      continue;
    }
    overdueCents += balance;
    if (overdueDays <= 30) aging.d1_30 += balance;
    else if (overdueDays <= 60) aging.d31_60 += balance;
    else if (overdueDays <= 90) aging.d61_90 += balance;
    else aging.d90_plus += balance;
  }

  return {
    revenueCents,
    expensesCents,
    grossProfitCents: revenueCents - expensesCents,
    taxCollectedCents,
    taxPaidCents,
    netTaxCents: taxCollectedCents - taxPaidCents,
    invoicedCents,
    collectedCents,
    outstandingCents,
    overdueCents,
    invoiceCount: invoiceRows.length,
    unpaidInvoiceCount,
    aging,
  };
}
