import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Monetary values are ALWAYS stored as integer minor units (e.g. cents). */
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "staff",
  "advisor",
  "firm_admin",
  "platform_admin",
]);
export const memberStatusEnum = pgEnum("member_status", ["active", "invited", "suspended"]);
export const invitationKindEnum = pgEnum("invitation_kind", ["member", "advisor"]);
export const advisorAccessStatusEnum = pgEnum("advisor_access_status", [
  "pending",
  "active",
  "revoked",
]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "overdue",
  "void",
]);
export const documentStatusEnum = pgEnum("document_status", [
  "uploaded",
  "in_review",
  "approved",
  "rejected",
]);
export const documentRequestStatusEnum = pgEnum("document_request_status", [
  "open",
  "fulfilled",
  "cancelled",
]);
export const taskStatusEnum = pgEnum("task_status", ["open", "in_progress", "done", "cancelled"]);
export const tenderProvenanceEnum = pgEnum("tender_provenance", [
  "sample",
  "manual_import",
  "authorized_feed",
]);
export const tenderSourceMethodEnum = pgEnum("tender_source_method", [
  "manual_import",
  "authorized_feed",
]);
export const eligibilityEnum = pgEnum("tender_eligibility", ["unknown", "likely", "unlikely"]);
export const checklistStatusEnum = pgEnum("bid_checklist_status", [
  "draft",
  "in_progress",
  "ready",
  "submitted",
]);
export const reconJobStatusEnum = pgEnum("recon_job_status", [
  "queued",
  "processing",
  "completed",
  "failed",
]);
export const reconFindingStatusEnum = pgEnum("recon_finding_status", [
  "open",
  "accepted",
  "resolved",
  "dismissed",
]);
export const reconSeverityEnum = pgEnum("recon_severity", ["info", "warning", "error"]);
export const emailStatusEnum = pgEnum("email_status", ["queued", "sending", "sent", "failed"]);
export const scanStatusEnum = pgEnum("scan_status", [
  "not_scanned",
  "clean",
  "infected",
  "error",
]);

/* ------------------------------------------------------------------ *
 * Identity & organizations
 * ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
    mfaLastStep: integer("mfa_last_step").notNull().default(0),
    mfaRecoveryUsedAt: timestamp("mfa_recovery_used_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("verification_tokens_hash_uq").on(t.tokenHash),
    index("verification_tokens_user_idx").on(t.userId),
    check("verification_tokens_purpose_ck", sql`${t.purpose} in ('email_verify','password_reset')`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("business"), // business | accounting_firm
    countryCode: text("country_code").notNull().default("RW"),
    defaultCurrency: text("default_currency").notNull().default("RWF"),
    plan: text("plan").notNull().default("free"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    check("organizations_kind_ck", sql`${t.kind} in ('business','accounting_firm')`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull(),
    status: memberStatusEnum("status").notNull().default("active"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const businessProfiles = pgTable(
  "business_profiles",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    legalName: text("legal_name").notNull(),
    tradingName: text("trading_name"),
    tin: text("tin"),
    registrationNumber: text("registration_number"),
    sector: text("sector"),
    city: text("city"),
    countryCode: text("country_code").notNull().default("RW"),
    currency: text("currency").notNull().default("RWF"),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    address: text("address"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("business_profiles_org_uq").on(t.orgId)],
);

/* ------------------------------------------------------------------ *
 * Invitations & advisor relationships
 * ------------------------------------------------------------------ */

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRoleEnum("role").notNull(),
    kind: invitationKindEnum("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_uq").on(t.tokenHash),
    index("invitations_org_idx").on(t.orgId),
    index("invitations_email_idx").on(t.email),
    check("invitations_role_ck", sql`${t.role} in ('owner','staff','advisor','firm_admin')`),
  ],
);

/** Explicit client authorization for an advisor to access a business org. */
export const advisorAccess = pgTable(
  "advisor_access",
  {
    id: id(),
    clientOrgId: text("client_org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    advisorUserId: text("advisor_user_id").references(() => users.id, { onDelete: "cascade" }),
    advisorEmail: text("advisor_email").notNull(),
    firmOrgId: text("firm_org_id").references(() => organizations.id, { onDelete: "set null" }),
    status: advisorAccessStatusEnum("status").notNull().default("pending"),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("advisor_access_org_email_uq").on(t.clientOrgId, t.advisorEmail),
    index("advisor_access_user_idx").on(t.advisorUserId),
  ],
);



/* ------------------------------------------------------------------ *
 * Contacts & financial records
 * ------------------------------------------------------------------ */

export const customers = pgTable(
  "customers",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    tin: text("tin"),
    address: text("address"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("customers_org_idx").on(t.orgId),
    index("customers_org_name_idx").on(t.orgId, t.name),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    tin: text("tin"),
    address: text("address"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("suppliers_org_idx").on(t.orgId)],
);

export const sales = pgTable(
  "sales",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    reference: text("reference"),
    description: text("description").notNull(),
    amountCents: money("amount_cents"),
    taxCents: money("tax_cents"),
    currency: text("currency").notNull().default("RWF"),
    occurredAt: date("occurred_at").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sales_org_date_idx").on(t.orgId, t.occurredAt),
    index("sales_org_reference_idx").on(t.orgId, t.reference),
    check("sales_amount_ck", sql`${t.amountCents} >= 0`),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    reference: text("reference"),
    category: text("category").notNull().default("general"),
    description: text("description").notNull(),
    amountCents: money("amount_cents"),
    taxCents: money("tax_cents"),
    currency: text("currency").notNull().default("RWF"),
    occurredAt: date("occurred_at").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expenses_org_date_idx").on(t.orgId, t.occurredAt),
    check("expenses_amount_ck", sql`${t.amountCents} >= 0`),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    currency: text("currency").notNull().default("RWF"),
    subtotalCents: money("subtotal_cents"),
    taxCents: money("tax_cents"),
    totalCents: money("total_cents"),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_org_number_uq").on(t.orgId, t.number),
    index("invoices_org_status_idx").on(t.orgId, t.status),
    index("invoices_org_due_idx").on(t.orgId, t.dueDate),
    check("invoices_total_ck", sql`${t.totalCents} >= 0`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("invoice_items_invoice_idx").on(t.invoiceId),
    check("invoice_items_qty_ck", sql`${t.quantity} > 0`),
    check("invoice_items_price_ck", sql`${t.unitPriceCents} >= 0`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    paidAt: date("paid_at").notNull(),
    method: text("method").notNull().default("bank_transfer"),
    reference: text("reference"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_invoice_idx").on(t.invoiceId),
    index("payments_org_date_idx").on(t.orgId, t.paidAt),
    check("payments_amount_ck", sql`${t.amountCents} > 0`),
  ],
);


/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originalFilename: text("original_filename").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    category: text("category").notNull().default("general"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    status: documentStatusEnum("status").notNull().default("uploaded"),
    reviewerId: text("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    scanStatus: scanStatusEnum("scan_status").notNull().default("not_scanned"),
    scanDetails: text("scan_details"),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("documents_storage_key_uq").on(t.storageKey),
    index("documents_org_idx").on(t.orgId, t.createdAt),
    index("documents_org_period_idx").on(t.orgId, t.periodStart, t.periodEnd),
    check("documents_size_ck", sql`${t.sizeBytes} > 0`),
  ],
);

export const documentRequests = pgTable(
  "document_requests",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    status: documentRequestStatusEnum("status").notNull().default("open"),
    documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("document_requests_org_idx").on(t.orgId, t.status)],
);

/* ------------------------------------------------------------------ *
 * Tasks & notifications
 * ------------------------------------------------------------------ */

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: text("priority").notNull().default("normal"),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    source: text("source").notNull().default("manual"),
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_org_status_idx").on(t.orgId, t.status),
    index("tasks_org_due_idx").on(t.orgId, t.dueDate),
    index("tasks_assignee_idx").on(t.assigneeUserId, t.status),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    type: text("type").notNull().default("general"),
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt),
    index("notifications_org_idx").on(t.orgId, t.createdAt),
    uniqueIndex("notifications_user_dedupe_uq").on(t.userId, t.dedupeKey),
  ],
);


/* ------------------------------------------------------------------ *
 * Tender intelligence
 * ------------------------------------------------------------------ */

export const tenderSources = pgTable(
  "tender_sources",
  {
    id: id(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: tenderSourceMethodEnum("method").notNull().default("manual_import"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    verifiedBy: text("verified_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("tender_sources_name_idx").on(t.name)],
);

export const tenders = pgTable(
  "tenders",
  {
    id: id(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => tenderSources.id, { onDelete: "set null" }),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    buyer: text("buyer"),
    description: text("description"),
    category: text("category"),
    region: text("region"),
    currency: text("currency").notNull().default("RWF"),
    budgetCents: bigint("budget_cents", { mode: "number" }),
    publishedAt: date("published_at"),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    sourceUrl: text("source_url").notNull(),
    provenance: tenderProvenanceEnum("provenance").notNull().default("manual_import"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tenders_org_reference_uq").on(t.orgId, t.reference),
    index("tenders_closes_idx").on(t.closesAt),
    index("tenders_org_idx").on(t.orgId, t.closesAt),
    check("tenders_source_url_ck", sql`${t.sourceUrl} ~ '^https?://'`),
  ],
);

export const tenderMatches = pgTable(
  "tender_matches",
  {
    id: id(),
    tenderId: text("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    relevanceScore: integer("relevance_score").notNull().default(0),
    eligibility: eligibilityEnum("eligibility").notNull().default("unknown"),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    saved: boolean("saved").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tender_matches_uq").on(t.tenderId, t.orgId),
    index("tender_matches_org_idx").on(t.orgId, t.relevanceScore),
    index("tender_matches_saved_idx").on(t.orgId, t.saved),
  ],
);

export const bidChecklists = pgTable(
  "bid_checklists",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tenderId: text("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    status: checklistStatusEnum("status").notNull().default("draft"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bid_checklists_org_tender_uq").on(t.orgId, t.tenderId)],
);

export const bidChecklistItems = pgTable(
  "bid_checklist_items",
  {
    id: id(),
    checklistId: text("checklist_id")
      .notNull()
      .references(() => bidChecklists.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    done: boolean("done").notNull().default(false),
    doneAt: timestamp("done_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("bid_checklist_items_list_idx").on(t.checklistId)],
);

/* ------------------------------------------------------------------ *
 * Reconciliation (EBM / accounting file imports)
 * ------------------------------------------------------------------ */

export const reconciliationJobs = pgTable(
  "reconciliation_jobs",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // ebm_sales | ebm_purchases
    filename: text("filename").notNull(),
    format: text("format").notNull(), // csv | xlsx
    mapping: jsonb("mapping").$type<Record<string, string>>().notNull(),
    status: reconJobStatusEnum("status").notNull().default("queued"),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsMatched: integer("rows_matched").notNull().default(0),
    findingsCount: integer("findings_count").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("recon_jobs_org_idx").on(t.orgId, t.createdAt)],
);

export const reconciliationFindings = pgTable(
  "reconciliation_findings",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => reconciliationJobs.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number"),
    code: text("code").notNull(),
    severity: reconSeverityEnum("severity").notNull(),
    message: text("message").notNull(),
    invoiceNumber: text("invoice_number"),
    expectedCents: bigint("expected_cents", { mode: "number" }),
    actualCents: bigint("actual_cents", { mode: "number" }),
    rawRow: jsonb("raw_row").$type<Record<string, string>>(),
    status: reconFindingStatusEnum("status").notNull().default("open"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("recon_findings_job_idx").on(t.jobId),
    index("recon_findings_org_status_idx").on(t.orgId, t.status),
  ],
);

/* ------------------------------------------------------------------ *
 * Audit & subscription entitlements
 * ------------------------------------------------------------------ */

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_org_idx").on(t.orgId, t.createdAt),
    index("audit_events_actor_idx").on(t.actorUserId, t.createdAt),
  ],
);

export const subscriptionEntitlements = pgTable(
  "subscription_entitlements",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    limitValue: bigint("limit_value", { mode: "number" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscription_entitlements_org_feature_uq").on(t.orgId, t.feature)],
);

/* ------------------------------------------------------------------ *
 * Multi-factor authentication
 * ------------------------------------------------------------------ */

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mfa_recovery_user_code_uq").on(t.userId, t.codeHash),
    index("mfa_recovery_user_idx").on(t.userId, t.usedAt),
  ],
);

export const mfaChallenges = pgTable(
  "mfa_challenges",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(), // login | enroll
    tokenHash: text("token_hash").notNull(),
    nextPath: text("next_path").notNull().default("/app/dashboard"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mfa_challenges_token_uq").on(t.tokenHash),
    index("mfa_challenges_user_idx").on(t.userId, t.expiresAt),
    check("mfa_challenges_purpose_ck", sql`${t.purpose} in ('login','enroll')`),
  ],
);

/* ------------------------------------------------------------------ *
 * Email outbox, rate limiting, notification preferences, job runs
 * ------------------------------------------------------------------ */

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: id(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key"),
    status: emailStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_outbox_dedupe_uq").on(t.dedupeKey),
    index("email_outbox_status_idx").on(t.status, t.nextAttemptAt),
    index("email_outbox_created_idx").on(t.createdAt),
  ],
);

/** Fixed-window counters; updated atomically with INSERT ... ON CONFLICT. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.key, t.windowStart] })],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    inAppEnabled: boolean("in_app_enabled").notNull().default(true),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_preferences_uq").on(t.userId, t.orgId, t.category)],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    name: text("name").notNull(),
    status: text("status").notNull(), // running | completed | failed
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_name_idx").on(t.name, t.startedAt)],
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MemberRole = Membership["role"];
export type DocumentRow = typeof documents.$inferSelect;
export type Tender = typeof tenders.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
