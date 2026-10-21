import readXlsxFile from "read-excel-file/node";
import { ValidationError } from "./errors";

export type SheetTable = { headers: string[]; rows: string[][] };

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim();
}

/** Reads the first worksheet of an .xlsx workbook into a header + rows table. */
export async function parseXlsx(bytes: Buffer): Promise<SheetTable> {
  let rows: unknown[][];
  try {
    rows = (await readXlsxFile(bytes)) as unknown as unknown[][];
  } catch {
    throw new ValidationError("The XLSX file could not be read. Export it again and retry.");
  }
  const nonEmpty = rows.filter((row) => row.some((cell) => cellToString(cell) !== ""));
  if (nonEmpty.length < 2) {
    throw new ValidationError("The sheet needs a header row and at least one data row");
  }
  const headers = (nonEmpty[0] ?? []).map((cell) => cellToString(cell));
  if (headers.some((header) => header === "")) {
    throw new ValidationError("Every column needs a header");
  }
  return {
    headers,
    rows: nonEmpty.slice(1).map((row) => row.map(cellToString)),
  };
}
