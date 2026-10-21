import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  customers,
  expenses,
  invoiceItems,
  invoices,
  organizations,
  payments,
  sales,
  suppliers,
} from "@/db/schema";
import { recordAuditSafe } from "./audit";
import type { OrgContext } from "./authz";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { computeFinancialSummary, deriveInvoiceStatus } from "./finance";
import { computeInvoiceTotals, formatMinor, MoneyError, parseMoneyToMinor } from "./money";
import { isUniqueViolation } from "./db-errors";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireFinance(ctx: OrgContext, write: boolean): void {
  if (!ctx.permissions.includes(write ? "finance:write" : "finance:read")) {
    throw new ForbiddenError();
  }
}

function moneyToMinor(value: string | number, currency: string, field: string): number {
  try {
    return parseMoneyToMinor(value, currency);
  } catch (error) {
    if (error instanceof MoneyError) throw new ValidationError(`${field}: ${error.message}`);
    throw error;
  }
}

function validDate(value: string, field: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError(`${field} must be a valid date (YYYY-MM-DD)`);
  }
  return value;
}

async function orgCurrency(db: AppDb, orgId: string): Promise<string> {
  const [org] = await db
    .select({ currency: organizations.defaultCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new NotFoundError("Organization not found");
  return org.currency;
}

export async function createSale(
  db: AppDb,
  ctx: OrgContext,
  input: {
    description: string;
    amount: string | number;
    tax?: string | number;
    occurredAt: string;
    reference?: string | null;
    customerId?: string | null;
  },
): Promise<{ id: string }> {
  requireFinance(ctx, true);
  const currency = await orgCurrency(db, ctx.orgId);
  if (input.description.trim().length < 2) throw new ValidationError("Enter a description");
  const amountCents = moneyToMinor(input.amount, currency, "Amount");
  if (amountCents <= 0) throw new ValidationError("Amount must be greater than zero");
  const taxCents = input.tax ? moneyToMinor(input.tax, currency, "Tax") : 0;
  const occurredAt = validDate(input.occurredAt, "Date");

  if (input.customerId) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.orgId)))
      .limit(1);
    if (!customer) throw new ValidationError("Unknown customer");
  }

  const [row] = await db
    .insert(sales)
    .values({
      orgId: ctx.orgId,
      customerId: input.customerId || null,
      reference: input.reference?.trim() || null,
      description: input.description.trim(),
      amountCents,
      taxCents,
      currency,
      occurredAt,
      createdBy: ctx.actor.user.id,
    })
    .returning({ id: sales.id });
  if (!row) throw new AppError("Could not save sale", 500);

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "sale.created",
    entityType: "sale",
    entityId: row.id,
    metadata: { amountCents, currency },
  });
  return row;
}

export async function createExpense(
  db: AppDb,
  ctx: OrgContext,
  input: {
    description: string;
    amount: string | number;
    tax?: string | number;
    occurredAt: string;
    category?: string;
    reference?: string | null;
    supplierId?: string | null;
  },
): Promise<{ id: string }> {
  requireFinance(ctx, true);
  const currency = await orgCurrency(db, ctx.orgId);
  if (input.description.trim().length < 2) throw new ValidationError("Enter a description");
  const amountCents = moneyToMinor(input.amount, currency, "Amount");
  if (amountCents <= 0) throw new ValidationError("Amount must be greater than zero");
  const taxCents = input.tax ? moneyToMinor(input.tax, currency, "Tax") : 0;
  const occurredAt = validDate(input.occurredAt, "Date");

  if (input.supplierId) {
    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.orgId, ctx.orgId)))
      .limit(1);
    if (!supplier) throw new ValidationError("Unknown supplier");
  }

  const [row] = await db
    .insert(expenses)
    .values({
      orgId: ctx.orgId,
      supplierId: input.supplierId || null,
      reference: input.reference?.trim() || null,
      category: input.category?.trim() || "general",
      description: input.description.trim(),
      amountCents,
      taxCents,
      currency,
      occurredAt,
      createdBy: ctx.actor.user.id,
    })
    .returning({ id: expenses.id });
  if (!row) throw new AppError("Could not save expense", 500);

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "expense.created",
    entityType: "expense",
    entityId: row.id,
    metadata: { amountCents, currency },
  });
  return row;
}

export async function listSales(
  db: AppDb,
  ctx: OrgContext,
  range: { from?: string; to?: string } = {},
) {
  requireFinance(ctx, false);
  const conditions = [eq(sales.orgId, ctx.orgId)];
  if (range.from) conditions.push(gte(sales.occurredAt, validDate(range.from, "From date")));
  if (range.to) conditions.push(lte(sales.occurredAt, validDate(range.to, "To date")));
  return db
    .select({
      id: sales.id,
      description: sales.description,
      reference: sales.reference,
      amountCents: sales.amountCents,
      taxCents: sales.taxCents,
      currency: sales.currency,
      occurredAt: sales.occurredAt,
      customerName: customers.name,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(...conditions))
    .orderBy(desc(sales.occurredAt), desc(sales.createdAt))
    .limit(500);
}

export async function listExpenses(
  db: AppDb,
  ctx: OrgContext,
  range: { from?: string; to?: string } = {},
) {
  requireFinance(ctx, false);
  const conditions = [eq(expenses.orgId, ctx.orgId)];
  if (range.from) conditions.push(gte(expenses.occurredAt, validDate(range.from, "From date")));
  if (range.to) conditions.push(lte(expenses.occurredAt, validDate(range.to, "To date")));
  return db
    .select({
      id: expenses.id,
      description: expenses.description,
      reference: expenses.reference,
      category: expenses.category,
      amountCents: expenses.amountCents,
      taxCents: expenses.taxCents,
      currency: expenses.currency,
      occurredAt: expenses.occurredAt,
      supplierName: suppliers.name,
    })
    .from(expenses)
    .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
    .where(and(...conditions))
    .orderBy(desc(expenses.occurredAt), desc(expenses.createdAt))
    .limit(500);
}


/* ------------------------------- Invoices ------------------------------- */

export type InvoiceLineInput = {
  description: string;
  quantity: number;
  unitPrice: string | number;
  taxRatePercent?: string | number;
};

export async function createInvoice(
  db: AppDb,
  ctx: OrgContext,
  input: {
    number?: string | null;
    customerId?: string | null;
    issueDate: string;
    dueDate: string;
    lines: InvoiceLineInput[];
    notes?: string | null;
    status?: "draft" | "sent";
  },
): Promise<{ id: string; number: string }> {
  requireFinance(ctx, true);
  const currency = await orgCurrency(db, ctx.orgId);
  const issueDate = validDate(input.issueDate, "Issue date");
  const dueDate = validDate(input.dueDate, "Due date");
  if (dueDate < issueDate) throw new ValidationError("Due date cannot be before the issue date");
  if (!input.lines.length) throw new ValidationError("Add at least one invoice line");
  if (input.lines.length > 50) throw new ValidationError("An invoice can have at most 50 lines");

  const computed = input.lines.map((line, index) => {
    const unitPriceCents = moneyToMinor(line.unitPrice, currency, `Line ${index + 1} unit price`);
    const taxRatePercent = Number(line.taxRatePercent ?? 0);
    if (!Number.isFinite(taxRatePercent) || taxRatePercent < 0 || taxRatePercent > 100) {
      throw new ValidationError(`Line ${index + 1} tax rate must be between 0 and 100`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError(`Line ${index + 1} quantity must be a positive whole number`);
    }
    const description = line.description.trim();
    if (description.length < 2) throw new ValidationError(`Line ${index + 1} needs a description`);
    const taxRateBp = Math.round(taxRatePercent * 100);
    const totals = computeInvoiceTotals([{ quantity: line.quantity, unitPriceCents, taxRateBp }]);
    return {
      description,
      quantity: line.quantity,
      unitPriceCents,
      taxRateBp,
      lineTotalCents: totals.totalCents,
      sortOrder: index,
    };
  });

  const totals = computeInvoiceTotals(
    computed.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxRateBp: line.taxRateBp,
    })),
  );

  if (input.customerId) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.orgId)))
      .limit(1);
    if (!customer) throw new ValidationError("Unknown customer");
  }

  const number = input.number?.trim() || (await nextInvoiceNumber(db, ctx.orgId));
  if (number.length > 60) throw new ValidationError("Invoice number is too long");

  try {
    const row = await db.transaction(async (tx) => {
      const [invoice] = await tx
        .insert(invoices)
        .values({
          orgId: ctx.orgId,
          customerId: input.customerId || null,
          number,
          issueDate,
          dueDate,
          currency,
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          status: input.status ?? "draft",
          notes: input.notes?.trim() || null,
          createdBy: ctx.actor.user.id,
        })
        .returning({ id: invoices.id, number: invoices.number });
      if (!invoice) throw new AppError("Could not create invoice", 500);

      await tx
        .insert(invoiceItems)
        .values(computed.map((line) => ({ invoiceId: invoice.id, ...line })));
      return invoice;
    });

    await recordAuditSafe(db, {
      orgId: ctx.orgId,
      actorUserId: ctx.actor.user.id,
      action: "invoice.created",
      entityType: "invoice",
      entityId: row.id,
      metadata: { number: row.number, totalCents: totals.totalCents, currency },
    });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("An invoice with that number already exists");
    }
    throw error;
  }
}


export async function recordPayment(
  db: AppDb,
  ctx: OrgContext,
  input: {
    invoiceId: string;
    amount: string | number;
    paidAt: string;
    method?: string;
    reference?: string | null;
  },
): Promise<void> {
  requireFinance(ctx, true);
  const currency = await orgCurrency(db, ctx.orgId);
  const amountCents = moneyToMinor(input.amount, currency, "Amount");
  if (amountCents <= 0) throw new ValidationError("Payment amount must be greater than zero");
  const paidAt = validDate(input.paidAt, "Payment date");

  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, ctx.orgId)))
      .for("update");
    if (!invoice) throw new NotFoundError("Invoice not found");
    if (invoice.status === "void" || invoice.status === "draft") {
      throw new ValidationError("Only issued invoices can receive payments");
    }

    const [paidRow] = await tx
      .select({ paid: sql<string>`coalesce(sum(${payments.amountCents}), 0)::text` })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.orgId, ctx.orgId)));
    const alreadyPaid = Number(paidRow?.paid ?? 0);
    const balance = invoice.totalCents - alreadyPaid;
    if (amountCents > balance) {
      throw new ValidationError(
        `Payment exceeds the outstanding balance of ${formatMinor(balance, invoice.currency)}`,
      );
    }

    await tx.insert(payments).values({
      orgId: ctx.orgId,
      invoiceId: invoice.id,
      amountCents,
      paidAt,
      method: input.method?.trim() || "bank_transfer",
      reference: input.reference?.trim() || null,
      createdBy: ctx.actor.user.id,
    });

    const status = deriveInvoiceStatus({
      current: invoice.status,
      totalCents: invoice.totalCents,
      paidCents: alreadyPaid + amountCents,
      dueDate: invoice.dueDate,
    });
    await tx.update(invoices).set({ status, updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
  });

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "payment.recorded",
    entityType: "invoice",
    entityId: input.invoiceId,
    metadata: { amountCents },
  });
}

export async function listInvoices(db: AppDb, ctx: OrgContext) {
  requireFinance(ctx, false);
  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      customerName: customers.name,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalCents: invoices.totalCents,
      currency: invoices.currency,
      status: invoices.status,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.orgId, ctx.orgId))
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt))
    .limit(500);

  const paidRows = await db
    .select({
      invoiceId: payments.invoiceId,
      paidCents: sql<string>`coalesce(sum(${payments.amountCents}), 0)::text`,
    })
    .from(payments)
    .where(eq(payments.orgId, ctx.orgId))
    .groupBy(payments.invoiceId);
  const paidMap = new Map(paidRows.map((row) => [row.invoiceId, Number(row.paidCents)]));

  const today = new Date().toISOString().slice(0, 10);
  return rows.map((row) => {
    const paidCents = paidMap.get(row.id) ?? 0;
    return {
      ...row,
      paidCents,
      balanceCents: Math.max(row.totalCents - paidCents, 0),
      overdue:
        row.dueDate < today &&
        row.status !== "paid" &&
        row.status !== "void" &&
        row.status !== "draft",
    };
  });
}

async function nextInvoiceNumber(db: AppDb, orgId: string): Promise<string> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.orgId, orgId));
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String((row?.total ?? 0) + 1).padStart(4, "0")}`;
}



export async function getInvoice(db: AppDb, ctx: OrgContext, invoiceId: string) {
  requireFinance(ctx, false);
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ctx.orgId)))
    .limit(1);
  if (!invoice) throw new NotFoundError("Invoice not found");

  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .orderBy(invoiceItems.sortOrder);
  const paymentRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.invoiceId, invoice.id), eq(payments.orgId, ctx.orgId)))
    .orderBy(desc(payments.paidAt));
  const paidCents = paymentRows.reduce((sum, row) => sum + row.amountCents, 0);

  let customerName: string | null = null;
  if (invoice.customerId) {
    const [customer] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, invoice.customerId))
      .limit(1);
    customerName = customer?.name ?? null;
  }

  return {
    invoice,
    items,
    payments: paymentRows,
    customerName,
    paidCents,
    balanceCents: Math.max(invoice.totalCents - paidCents, 0),
  };
}

/* ------------------------------- Dashboard ------------------------------- */

export async function getDashboardData(db: AppDb, ctx: OrgContext) {
  requireFinance(ctx, false);
  const saleRows = await db
    .select({
      amountCents: sales.amountCents,
      taxCents: sales.taxCents,
      currency: sales.currency,
      occurredAt: sales.occurredAt,
    })
    .from(sales)
    .where(eq(sales.orgId, ctx.orgId));
  const expenseRows = await db
    .select({
      amountCents: expenses.amountCents,
      taxCents: expenses.taxCents,
      occurredAt: expenses.occurredAt,
    })
    .from(expenses)
    .where(eq(expenses.orgId, ctx.orgId));
  const invoiceRows = await db
    .select({
      totalCents: invoices.totalCents,
      status: invoices.status,
      dueDate: invoices.dueDate,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(eq(invoices.orgId, ctx.orgId));
  const paymentRows = await db
    .select({ amountCents: payments.amountCents, paidAt: payments.paidAt })
    .from(payments)
    .where(eq(payments.orgId, ctx.orgId));

  const summary = computeFinancialSummary(saleRows, expenseRows, invoiceRows, paymentRows);

  const months: { month: string; revenueCents: number; expenseCents: number }[] = [];
  const now = new Date();
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const month = date.toISOString().slice(0, 7);
    months.push({
      month,
      revenueCents: saleRows
        .filter((row) => row.occurredAt.startsWith(month))
        .reduce((sum, row) => sum + row.amountCents, 0),
      expenseCents: expenseRows
        .filter((row) => row.occurredAt.startsWith(month))
        .reduce((sum, row) => sum + row.amountCents, 0),
    });
  }

  return { summary, months, currency: await orgCurrency(db, ctx.orgId) };
}

/* -------------------------------- Contacts ------------------------------- */

export async function createCustomer(
  db: AppDb,
  ctx: OrgContext,
  input: { name: string; email?: string | null; phone?: string | null; tin?: string | null; address?: string | null },
): Promise<{ id: string }> {
  requireFinance(ctx, true);
  if (input.name.trim().length < 2) throw new ValidationError("Enter a customer name");
  const [row] = await db
    .insert(customers)
    .values({
      orgId: ctx.orgId,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      tin: input.tin?.trim() || null,
      address: input.address?.trim() || null,
    })
    .returning({ id: customers.id });
  if (!row) throw new AppError("Could not save customer", 500);
  return row;
}

export async function createSupplier(
  db: AppDb,
  ctx: OrgContext,
  input: { name: string; email?: string | null; phone?: string | null; tin?: string | null; address?: string | null },
): Promise<{ id: string }> {
  requireFinance(ctx, true);
  if (input.name.trim().length < 2) throw new ValidationError("Enter a supplier name");
  const [row] = await db
    .insert(suppliers)
    .values({
      orgId: ctx.orgId,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      tin: input.tin?.trim() || null,
      address: input.address?.trim() || null,
    })
    .returning({ id: suppliers.id });
  if (!row) throw new AppError("Could not save supplier", 500);
  return row;
}

export async function listContacts(db: AppDb, ctx: OrgContext) {
  requireFinance(ctx, false);
  const [customerRows, supplierRows] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(eq(customers.orgId, ctx.orgId))
      .orderBy(customers.name)
      .limit(500),
    db
      .select()
      .from(suppliers)
      .where(eq(suppliers.orgId, ctx.orgId))
      .orderBy(suppliers.name)
      .limit(500),
  ]);
  return { customers: customerRows, suppliers: supplierRows };
}


export async function setInvoiceStatus(
  db: AppDb,
  ctx: OrgContext,
  invoiceId: string,
  status: "draft" | "sent" | "void",
): Promise<void> {
  requireFinance(ctx, true);
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ctx.orgId)))
    .limit(1);
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (["paid", "partially_paid"].includes(invoice.status) && status !== "void") {
    throw new ValidationError("Invoices with payments cannot be reopened");
  }
  await db
    .update(invoices)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ctx.orgId)));
  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: `invoice.${status}`,
    entityType: "invoice",
    entityId: invoiceId,
  });
}
