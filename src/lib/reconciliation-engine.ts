import { parseAmountCell } from "./csv";
import { minorUnits } from "./money";

export type ColumnMapping = {
  invoiceNumber: string;
  amount: string;
  date?: string;
  counterparty?: string;
  tax?: string;
};

export type ReconSource = "ebm_sales" | "ebm_purchases";

export type EngineInvoice = {
  number: string;
  totalCents: number;
  issueDate: string;
};

export type EngineExpense = {
  reference: string | null;
  amountCents: number;
  occurredAt: string;
};

export type Finding = {
  rowNumber: number | null;
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  invoiceNumber: string | null;
  expectedCents: number | null;
  actualCents: number | null;
  rawRow: Record<string, string>;
};

export type RowOutcome = { matched: boolean; findings: Finding[] };

/** Accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY; returns ISO date or null. */
export function parseDateCell(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

export function toMinorAmount(value: string, currency: string): number | null {
  const parsed = parseAmountCell(value);
  if (parsed === null) return null;
  const factor = minorUnits(currency) === 0 ? 1 : 100;
  return Math.round(parsed * factor);
}

function baseFinding(
  rowNumber: number,
  rawRow: Record<string, string>,
): Pick<Finding, "rowNumber" | "rawRow"> {
  return { rowNumber, rawRow };
}

export function reconcileSalesRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  invoicesByNumber: Map<string, EngineInvoice>,
  currency: string,
  options: { amountToleranceCents?: number; maxDateDriftDays?: number } = {},
): { outcomes: RowOutcome[]; rowsMatched: number } {
  const tolerance = options.amountToleranceCents ?? 0;
  const maxDrift = options.maxDateDriftDays ?? 45;
  const seen = new Set<string>();
  const outcomes: RowOutcome[] = [];
  let rowsMatched = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // header is row 1
    const findings: Finding[] = [];
    const invoiceNumber = (row[mapping.invoiceNumber] ?? "").trim();
    const actualCents = toMinorAmount(row[mapping.amount] ?? "", currency);

    if (!invoiceNumber) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "MISSING_REFERENCE",
        severity: "error",
        message: "This row has no invoice number, so it cannot be matched",
        invoiceNumber: null,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }

    if (actualCents === null) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "INVALID_AMOUNT",
        severity: "error",
        message: "The amount could not be read as a number",
        invoiceNumber,
        expectedCents: null,
        actualCents: null,
      });
      outcomes.push({ matched: false, findings });
      return;
    }

    if (seen.has(invoiceNumber)) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "DUPLICATE_ROW",
        severity: "warning",
        message: "This invoice number already appeared in the imported file",
        invoiceNumber,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }
    seen.add(invoiceNumber);

    const invoice = invoicesByNumber.get(invoiceNumber);
    if (!invoice) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "MISSING_IN_SYSTEM",
        severity: "error",
        message: "Reported sale has no matching invoice in this organization",
        invoiceNumber,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }

    if (Math.abs(invoice.totalCents - actualCents) > tolerance) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "AMOUNT_MISMATCH",
        severity: "error",
        message: `Reported amount differs from invoice ${invoice.number} by ${Math.abs(invoice.totalCents - actualCents)} minor units`,
        invoiceNumber,
        expectedCents: invoice.totalCents,
        actualCents,
      });
    }

    if (mapping.date) {
      const reportedDate = parseDateCell(row[mapping.date] ?? "");
      if (reportedDate) {
        const drift = Math.abs(
          (Date.parse(`${reportedDate}T00:00:00Z`) -
            Date.parse(`${invoice.issueDate}T00:00:00Z`)) /
            86_400_000,
        );
        if (drift > maxDrift) {
          findings.push({
            ...baseFinding(rowNumber, row),
            code: "DATE_MISMATCH",
            severity: "info",
            message: `Reported date is ${Math.round(drift)} days away from the invoice issue date`,
            invoiceNumber,
            expectedCents: null,
            actualCents,
          });
        }
      }
    }

    const hasError = findings.some((finding) => finding.severity === "error");
    if (!hasError) rowsMatched += 1;
    outcomes.push({ matched: !hasError, findings });
  });

  return { outcomes, rowsMatched };
}

export function reconcilePurchaseRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  expensesByReference: Map<string, EngineExpense>,
  currency: string,
): { outcomes: RowOutcome[]; rowsMatched: number } {
  const seen = new Set<string>();
  const outcomes: RowOutcome[] = [];
  let rowsMatched = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const findings: Finding[] = [];
    const reference = (row[mapping.invoiceNumber] ?? "").trim();
    const actualCents = toMinorAmount(row[mapping.amount] ?? "", currency);

    if (!reference) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "MISSING_REFERENCE",
        severity: "error",
        message: "This purchase row has no supplier invoice reference",
        invoiceNumber: null,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }
    if (actualCents === null) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "INVALID_AMOUNT",
        severity: "error",
        message: "The amount could not be read as a number",
        invoiceNumber: reference,
        expectedCents: null,
        actualCents: null,
      });
      outcomes.push({ matched: false, findings });
      return;
    }
    if (seen.has(reference)) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "DUPLICATE_ROW",
        severity: "warning",
        message: "This supplier invoice reference already appeared in the file",
        invoiceNumber: reference,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }
    seen.add(reference);

    const expense = expensesByReference.get(reference);
    if (!expense) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "MISSING_IN_SYSTEM",
        severity: "error",
        message: "Reported purchase has no matching expense record",
        invoiceNumber: reference,
        expectedCents: null,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }
    if (expense.amountCents !== actualCents) {
      findings.push({
        ...baseFinding(rowNumber, row),
        code: "AMOUNT_MISMATCH",
        severity: "error",
        message: "Reported purchase amount differs from the recorded expense",
        invoiceNumber: reference,
        expectedCents: expense.amountCents,
        actualCents,
      });
      outcomes.push({ matched: false, findings });
      return;
    }

    rowsMatched += 1;
    outcomes.push({ matched: true, findings });
  });

  return { outcomes, rowsMatched };
}

