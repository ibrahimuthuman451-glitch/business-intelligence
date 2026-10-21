import type { AppDb } from "@/db/client";
import type { OrgContext } from "./authz";
import { listInvoices, listSales } from "./finance-service";
import { listTasks } from "./tasks";
import { formatMinor } from "./money";

export type ReportType = "sales" | "invoices" | "tasks";

/** Prevents spreadsheet formula injection in exported cells. */
export function csvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export type ReportFile = { filename: string; csv: string };

export async function buildReport(
  db: AppDb,
  ctx: OrgContext,
  type: ReportType,
  options: { today?: string } = {},
): Promise<ReportFile> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (type === "sales") {
    const rows = await listSales(db, ctx);
    const currency = rows[0]?.currency ?? "RWF";
    const totalNet = rows.reduce((sum, row) => sum + row.amountCents, 0);
    const totalTax = rows.reduce((sum, row) => sum + row.taxCents, 0);
    const csv = toCsv(
      ["Date", "Description", "Customer", "Reference", `Net (${currency})`, `Tax (${currency})`, `Gross (${currency})`],
      [
        ...rows.map((row) => [
          row.occurredAt,
          row.description,
          row.customerName ?? "",
          row.reference ?? "",
          formatMinor(row.amountCents, currency),
          formatMinor(row.taxCents, currency),
          formatMinor(row.amountCents + row.taxCents, currency),
        ]),
        ["", "TOTAL", "", "", formatMinor(totalNet, currency), formatMinor(totalTax, currency), formatMinor(totalNet + totalTax, currency)],
      ],
    );
    return { filename: `sales-${today}.csv`, csv };
  }

  if (type === "invoices") {
    const rows = await listInvoices(db, ctx);
    const currency = rows[0]?.currency ?? "RWF";
    const totalOutstanding = rows.reduce((sum, row) => sum + row.balanceCents, 0);
    const csv = toCsv(
      ["Number", "Customer", "Issued", "Due", "Status", `Total (${currency})`, `Paid (${currency})`, `Balance (${currency})`],
      [
        ...rows.map((row) => [
          row.number,
          row.customerName ?? "",
          row.issueDate,
          row.dueDate,
          row.status,
          formatMinor(row.totalCents, currency),
          formatMinor(row.paidCents, currency),
          formatMinor(row.balanceCents, currency),
        ]),
        ["", "", "", "", "OUTSTANDING", "", "", formatMinor(totalOutstanding, currency)],
      ],
    );
    return { filename: `invoices-${today}.csv`, csv };
  }

  const rows = await listTasks(db, ctx, { status: "all" });
  const csv = toCsv(
    ["Task", "Status", "Priority", "Assignee", "Due date", "Client", "Period start", "Period end", "Overdue"],
    rows.map((row) => [
      row.title,
      row.status,
      row.priority,
      row.assigneeName ?? "Unassigned",
      row.dueDate ?? "",
      row.customerName ?? "",
      row.periodStart ?? "",
      row.periodEnd ?? "",
      row.overdue ? "yes" : "no",
    ]),
  );
  return { filename: `tasks-${today}.csv`, csv };
}
