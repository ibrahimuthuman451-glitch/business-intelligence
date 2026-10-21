/** Currencies whose smallest unit is the whole unit (no decimals). */
const ZERO_DECIMAL = new Set(["RWF", "JPY", "KRW", "VND", "CLP", "ISK", "UGX", "TZS", "BIF"]);

export function minorUnits(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export class MoneyError extends Error {}

/**
 * Parses a human-entered amount ("1,250.50", "1 250") into integer minor units.
 * Rejects NaN, negatives and unsupported precision rather than silently rounding.
 */
export function parseMoneyToMinor(input: string | number, currency: string): number {
  const raw = typeof input === "number" ? String(input) : input.trim();
  if (raw === "") throw new MoneyError("Amount is required");
  const normalized = raw.replace(/[\s,_]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new MoneyError(`"${input}" is not a valid amount`);
  }
  const digits = minorUnits(currency);
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > digits) {
    throw new MoneyError(
      digits === 0
        ? `${currency} does not use decimal places`
        : `At most ${digits} decimal places are allowed for ${currency}`,
    );
  }
  const scaled = BigInt(whole + fraction.padEnd(digits, "0"));
  if (scaled < 0n) throw new MoneyError("Amount cannot be negative");
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("Amount is too large");
  return Number(scaled);
}

/** Renders minor units as a plain decimal string (no currency symbol). */
export function formatMinor(amount: number | bigint, currency: string): string {
  const value = typeof amount === "bigint" ? amount : BigInt(Math.trunc(amount));
  const digits = minorUnits(currency);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (digits === 0) return `${negative ? "-" : ""}${abs.toString()}`;
  const text = abs.toString().padStart(3, "0");
  const whole = text.slice(0, -digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${text.slice(-digits)}`;
}

export function formatMoney(amount: number | bigint, currency: string): string {
  const symbols: Record<string, string> = { RWF: "FRw", USD: "$", EUR: "€", KES: "KSh" };
  return `${symbols[currency.toUpperCase()] ?? `${currency} `}${formatMinor(amount, currency)}`;
}

export type LineInput = { quantity: number; unitPriceCents: number; taxRateBp: number };

export type LineTotals = { subtotalCents: number; taxCents: number; totalCents: number };

export function lineTotals(line: LineInput): LineTotals {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new MoneyError("Quantity must be a positive whole number");
  }
  if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
    throw new MoneyError("Unit price must be a non-negative amount");
  }
  if (!Number.isInteger(line.taxRateBp) || line.taxRateBp < 0 || line.taxRateBp > 10000) {
    throw new MoneyError("Tax rate must be between 0% and 100%");
  }
  const subtotalCents = line.quantity * line.unitPriceCents;
  const taxCents = Math.round((subtotalCents * line.taxRateBp) / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function computeInvoiceTotals(lines: LineInput[]): LineTotals {
  if (lines.length === 0) throw new MoneyError("An invoice needs at least one line");
  return lines.reduce<LineTotals>(
    (acc, line) => {
      const totals = lineTotals(line);
      return {
        subtotalCents: acc.subtotalCents + totals.subtotalCents,
        taxCents: acc.taxCents + totals.taxCents,
        totalCents: acc.totalCents + totals.totalCents,
      };
    },
    { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  );
}
