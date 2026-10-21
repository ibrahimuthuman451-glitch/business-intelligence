import { ValidationError } from "./errors";

export type CsvTable = { headers: string[]; rows: string[][]; delimiter: string };

function detectDelimiter(firstLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    // Count only delimiters outside quotes.
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const char = firstLine[i];
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC4180-style CSV parser: supports quoted fields, escaped quotes, CRLF,
 * embedded newlines and a UTF-8 BOM. No third-party parser needed.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  if (!input.trim()) throw new ValidationError("The CSV file is empty");

  const delimiter = detectDelimiter(input.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      if (char === "\r" && input[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (quoted) throw new ValidationError("The CSV file has an unterminated quoted field");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  if (rows.length < 2) throw new ValidationError("The file needs a header row and at least one data row");
  const headers = (rows[0] ?? []).map((header) => header.trim());
  if (headers.some((header) => header === "")) {
    throw new ValidationError("Every column needs a header");
  }
  return rows;
}

export function parseCsvTable(text: string): CsvTable {
  const parsed = parseCsv(text);
  const headers = parsed[0] ?? [];
  return {
    headers,
    rows: parsed.slice(1),
    get delimiter() {
      return detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
    },
  };
}

export function rowsToObjects(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((row) => {
    const object: Record<string, string> = {};
    headers.forEach((header, index) => {
      object[header] = (row[index] ?? "").trim();
    });
    return object;
  });
}

/** Parses a numeric cell that may use thousands separators or currency symbols. */
export function parseAmountCell(value: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/[^\d.,-]/g, "");
  if (!normalized || normalized === "-") return null;
  // Treat both "1,000.50" and "1.000,50" sensibly.
  let candidate = normalized;
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma > lastDot) candidate = normalized.replace(/\./g, "").replace(",", ".");
  else candidate = normalized.replace(/,/g, "");
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}
