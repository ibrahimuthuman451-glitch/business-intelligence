import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  expenses,
  invoices,
  organizations,
  reconciliationFindings,
  reconciliationJobs,
} from "@/db/schema";
import { recordAuditSafe } from "./audit";
import type { OrgContext } from "./authz";
import { parseCsvTable, rowsToObjects } from "./csv";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  reconcilePurchaseRows,
  reconcileSalesRows,
  type ColumnMapping,
  type ReconSource,
} from "./reconciliation-engine";
import { parseXlsx } from "./xlsx";

export type ParsedTable = { headers: string[]; rows: string[][]; format: "csv" | "xlsx" };

export async function parseTabularFile(input: {
  filename: string;
  bytes: Buffer;
}): Promise<ParsedTable> {
  const extension = input.filename.toLowerCase().split(".").pop();
  if (extension === "csv" || extension === "txt") {
    if (input.bytes.includes(0x00)) throw new ValidationError("This is not a valid text CSV file");
    const text = input.bytes.toString("utf8");
    const table = parseCsvTable(text);
    return { headers: table.headers, rows: table.rows, format: "csv" };
  }
  if (extension === "xlsx") {
    const table = await parseXlsx(input.bytes);
    return { ...table, format: "xlsx" };
  }
  throw new ValidationError("Only CSV and XLSX imports are supported");
}

const FIELD_ALIASES: Record<keyof ColumnMapping, string[]> = {
  invoiceNumber: ["invoice number", "invoice no", "invoice", "number", "reference", "ref", "facture"],
  amount: ["total", "amount", "grand total", "total amount", "montant", "value"],
  date: ["date", "invoice date", "transaction date", "issued"],
  counterparty: ["customer", "client", "buyer", "supplier", "vendor", "name"],
  tax: ["tax", "vat", "tva", "tax amount"],
};

/** Proposes a column mapping from header names; always user-confirmed before use. */
export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const normalized = headers.map((header) => ({ header, key: header.trim().toLowerCase() }));
  const suggestion: Partial<ColumnMapping> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [
    keyof ColumnMapping,
    string[],
  ][]) {
    const exact = normalized.find((column) => aliases.includes(column.key));
    const partial =
      exact ?? normalized.find((column) => aliases.some((alias) => column.key.includes(alias)));
    if (partial) suggestion[field] = partial.header;
  }
  return suggestion;
}

function validateMapping(mapping: ColumnMapping, headers: string[]): void {
  const missing: string[] = [];
  if (!mapping.invoiceNumber || !headers.includes(mapping.invoiceNumber)) {
    missing.push("invoice number");
  }
  if (!mapping.amount || !headers.includes(mapping.amount)) missing.push("amount");
  if (missing.length) {
    throw new ValidationError(`Map these required columns before importing: ${missing.join(", ")}`);
  }
}

export async function runReconciliation(
  db: AppDb,
  ctx: OrgContext,
  input: {
    source: ReconSource;
    filename: string;
    bytes: Buffer;
    mapping: ColumnMapping;
  },
  meta: { ipAddress?: string | null } = {},
): Promise<{ jobId: string; rowsTotal: number; rowsMatched: number; findingsCount: number }> {
  if (!ctx.permissions.includes("recon:write")) throw new ForbiddenError();
  if (!["ebm_sales", "ebm_purchases"].includes(input.source)) {
    throw new ValidationError("Choose an import type");
  }

  const table = await parseTabularFile(input);
  validateMapping(input.mapping, table.headers);
  const rows = rowsToObjects(table.headers, table.rows);
  if (rows.length === 0) throw new ValidationError("The file has no data rows");
  if (rows.length > 2000) throw new ValidationError("Import at most 2,000 rows per job");

  const [org] = await db
    .select({ currency: organizations.defaultCurrency })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .limit(1);
  if (!org) throw new NotFoundError("Organization not found");

  const [job] = await db
    .insert(reconciliationJobs)
    .values({
      orgId: ctx.orgId,
      source: input.source,
      filename: input.filename.slice(0, 200),
      format: table.format,
      mapping: input.mapping as unknown as Record<string, string>,
      status: "processing",
      rowsTotal: rows.length,
      createdBy: ctx.actor.user.id,
    })
    .returning({ id: reconciliationJobs.id });
  if (!job) throw new AppError("Could not create reconciliation job", 500);

  try {
    let outcomes: ReturnType<typeof reconcileSalesRows>["outcomes"];
    let rowsMatched = 0;

    if (input.source === "ebm_sales") {
      const invoiceRows = await db
        .select({
          number: invoices.number,
          totalCents: invoices.totalCents,
          issueDate: invoices.issueDate,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, ctx.orgId),
            inArray(invoices.status, ["sent", "partially_paid", "paid", "overdue"]),
          ),
        );
      const byNumber = new Map(invoiceRows.map((row) => [row.number, row]));
      const result = reconcileSalesRows(rows, input.mapping, byNumber, org.currency);
      outcomes = result.outcomes;
      rowsMatched = result.rowsMatched;
    } else {
      const expenseRows = await db
        .select({
          reference: expenses.reference,
          amountCents: expenses.amountCents,
          occurredAt: expenses.occurredAt,
        })
        .from(expenses)
        .where(eq(expenses.orgId, ctx.orgId));
      const byReference = new Map(
        expenseRows.filter((row) => row.reference).map((row) => [row.reference as string, row]),
      );
      const result = reconcilePurchaseRows(rows, input.mapping, byReference, org.currency);
      outcomes = result.outcomes;
      rowsMatched = result.rowsMatched;
    }

    const findings = outcomes.flatMap((outcome) => outcome.findings);
    await db.transaction(async (tx) => {
      if (findings.length > 0) {
        await tx.insert(reconciliationFindings).values(
          findings.map((finding) => ({
            jobId: job.id,
            orgId: ctx.orgId,
            rowNumber: finding.rowNumber,
            code: finding.code,
            severity: finding.severity,
            message: finding.message,
            invoiceNumber: finding.invoiceNumber,
            expectedCents: finding.expectedCents,
            actualCents: finding.actualCents,
            rawRow: finding.rawRow,
          })),
        );
      }
      await tx
        .update(reconciliationJobs)
        .set({
          status: "completed",
          rowsMatched,
          findingsCount: findings.length,
          completedAt: new Date(),
        })
        .where(eq(reconciliationJobs.id, job.id));
    });

    await recordAuditSafe(db, {
      orgId: ctx.orgId,
      actorUserId: ctx.actor.user.id,
      actorEmail: ctx.actor.user.email,
      action: "reconciliation.completed",
      entityType: "reconciliation_job",
      entityId: job.id,
      metadata: {
        source: input.source,
        rows: rows.length,
        matched: rowsMatched,
        findings: findings.length,
      },
      ipAddress: meta.ipAddress,
    });

    return { jobId: job.id, rowsTotal: rows.length, rowsMatched, findingsCount: findings.length };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Import failed";
    await db
      .update(reconciliationJobs)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(reconciliationJobs.id, job.id));
    throw error;
  }
}

export async function listReconciliationJobs(db: AppDb, ctx: OrgContext) {
  if (!ctx.permissions.includes("recon:read")) throw new ForbiddenError();
  return db
    .select()
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.orgId, ctx.orgId))
    .orderBy(desc(reconciliationJobs.createdAt))
    .limit(100);
}

export async function getReconciliationJob(db: AppDb, ctx: OrgContext, jobId: string) {
  if (!ctx.permissions.includes("recon:read")) throw new ForbiddenError();
  const [job] = await db
    .select()
    .from(reconciliationJobs)
    .where(and(eq(reconciliationJobs.id, jobId), eq(reconciliationJobs.orgId, ctx.orgId)))
    .limit(1);
  if (!job) throw new NotFoundError("Reconciliation job not found");
  const findings = await db
    .select()
    .from(reconciliationFindings)
    .where(
      and(eq(reconciliationFindings.jobId, job.id), eq(reconciliationFindings.orgId, ctx.orgId)),
    )
    .orderBy(reconciliationFindings.rowNumber);
  return { job, findings };
}

export async function reviewFinding(
  db: AppDb,
  ctx: OrgContext,
  findingId: string,
  input: { status: "accepted" | "resolved" | "dismissed"; note?: string | null },
): Promise<void> {
  if (!ctx.permissions.includes("recon:review")) throw new ForbiddenError();
  const [finding] = await db
    .select({ id: reconciliationFindings.id, jobId: reconciliationFindings.jobId })
    .from(reconciliationFindings)
    .where(
      and(eq(reconciliationFindings.id, findingId), eq(reconciliationFindings.orgId, ctx.orgId)),
    )
    .limit(1);
  if (!finding) throw new NotFoundError("Finding not found");

  await db
    .update(reconciliationFindings)
    .set({
      status: input.status,
      resolutionNote: input.note?.slice(0, 2000) ?? null,
      reviewedBy: ctx.actor.user.id,
      reviewedAt: new Date(),
    })
    .where(
      and(eq(reconciliationFindings.id, finding.id), eq(reconciliationFindings.orgId, ctx.orgId)),
    );

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: `reconciliation.finding_${input.status}`,
    entityType: "reconciliation_finding",
    entityId: finding.id,
    metadata: { jobId: finding.jobId, note: input.note ?? null },
  });
}

