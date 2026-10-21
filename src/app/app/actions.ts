"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { describeError } from "@/lib/request";
import { linksVisibleInUi } from "@/lib/email";
import { sendEmail } from "@/lib/email/outbox";
import { invitationEmailWithToken } from "@/lib/email/templates";
import {
  createCustomer,
  createExpense,
  createInvoice,
  createSale,
  createSupplier,
  recordPayment,
  setInvoiceStatus,
} from "@/lib/finance-service";
import {
  createDocument,
  createDocumentRequest,
  deleteDocument,
  fulfilDocumentRequest,
  reviewDocument,
} from "@/lib/documents";
import { maxUploadBytes } from "@/lib/storage";
import {
  assessTenderFit,
  ensureChecklist,
  importTender,
  setTenderSaved,
  toggleChecklistItem,
} from "@/lib/tenders";
import { runReconciliation } from "@/lib/reconciliation";
import {
  createMemberInvitation,
  grantAdvisorAccess,
  revokeAdvisorAccess,
  type InvitableRole,
} from "@/lib/team";
import { changePassword } from "@/lib/auth";
import { completeTask, createTask, updateTask } from "@/lib/tasks";
import { createOrganizationForUser } from "@/lib/organizations";
import { setActiveOrgCookie } from "@/lib/session-cookie";
import {
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_CATEGORIES,
  setNotificationPreference,
} from "@/lib/notifications";
import { businessProfiles, organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { recordAuditSafe } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optional(form: FormData, key: string): string | null {
  const value = field(form, key);
  return value === "" ? null : value;
}

function backPath(form: FormData, fallback: string): string {
  const value = field(form, "returnTo");
  return value.startsWith("/app") ? value : fallback;
}

function emailNotice(status: string, subject: string): string {
  if (status === "sent" || status === "duplicate") return `${subject} sent.`;
  if (status === "queued") return `${subject} queued; delivery will be retried.`;
  return `${subject} could not be delivered.`;
}

async function finish(path: string, work: () => Promise<string>): Promise<void> {
  let message: string;
  try {
    message = await work();
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(describeError(error))}`);
  }
  revalidatePath(path.split("?")[0] ?? path);
  redirect(`${path}?ok=${encodeURIComponent(message)}`);
}

export async function createSaleAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/sales");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await createSale(getDb(), org, {
      description: field(formData, "description"),
      amount: field(formData, "amount"),
      tax: field(formData, "tax") || undefined,
      occurredAt: field(formData, "occurredAt"),
      reference: optional(formData, "reference"),
      customerId: optional(formData, "customerId"),
    });
    return "Sale recorded.";
  });
}

export async function createExpenseAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/expenses");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await createExpense(getDb(), org, {
      description: field(formData, "description"),
      amount: field(formData, "amount"),
      tax: field(formData, "tax") || undefined,
      occurredAt: field(formData, "occurredAt"),
      category: field(formData, "category"),
      reference: optional(formData, "reference"),
      supplierId: optional(formData, "supplierId"),
    });
    return "Expense recorded.";
  });
}

export async function createCustomerAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/contacts");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await createCustomer(getDb(), org, {
      name: field(formData, "name"),
      email: optional(formData, "email"),
      phone: optional(formData, "phone"),
      tin: optional(formData, "tin"),
      address: optional(formData, "address"),
    });
    return "Customer added.";
  });
}

export async function createSupplierAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/contacts");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await createSupplier(getDb(), org, {
      name: field(formData, "name"),
      email: optional(formData, "email"),
      phone: optional(formData, "phone"),
      tin: optional(formData, "tin"),
      address: optional(formData, "address"),
    });
    return "Supplier added.";
  });
}

export async function createInvoiceAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/invoices");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    let lines: unknown;
    try {
      lines = JSON.parse(field(formData, "lines") || "[]");
    } catch {
      throw new ValidationError("The invoice lines could not be read");
    }
    if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError("Add at least one line");
    const parsed = lines.map((line) => ({
      description: String((line as { description?: unknown }).description ?? ""),
      quantity: Number((line as { quantity?: unknown }).quantity ?? 0),
      unitPrice: String((line as { unitPrice?: unknown }).unitPrice ?? ""),
      taxRatePercent: String((line as { taxRatePercent?: unknown }).taxRatePercent ?? "0"),
    }));
    await createInvoice(getDb(), org, {
      number: optional(formData, "number"),
      customerId: optional(formData, "customerId"),
      issueDate: field(formData, "issueDate"),
      dueDate: field(formData, "dueDate"),
      notes: optional(formData, "notes"),
      status: field(formData, "status") === "draft" ? "draft" : "sent",
      lines: parsed,
    });
    return "Invoice created.";
  });
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const invoiceId = field(formData, "invoiceId");
  const path = `/app/invoices/${invoiceId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await recordPayment(getDb(), org, {
      invoiceId,
      amount: field(formData, "amount"),
      paidAt: field(formData, "paidAt"),
      method: field(formData, "method"),
      reference: optional(formData, "reference"),
    });
    return "Payment recorded.";
  });
}

export async function setInvoiceStatusAction(formData: FormData): Promise<void> {
  const invoiceId = field(formData, "invoiceId");
  const status = field(formData, "status");
  const path = `/app/invoices/${invoiceId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    if (status !== "draft" && status !== "sent" && status !== "void") {
      throw new ValidationError("Invalid invoice status");
    }
    await setInvoiceStatus(getDb(), org, invoiceId, status);
    return `Invoice marked ${status}.`;
  });
}

export async function uploadDocumentAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/documents");
  await finish(path, async () => {
    const { org } = await requirePageContext("documents:write");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file to upload");
    if (file.size > maxUploadBytes()) {
      throw new ValidationError(`File is too large. Maximum ${Math.floor(maxUploadBytes() / 1048576)} MB`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    await createDocument(getDb(), org, {
      filename: file.name,
      declaredMimeType: file.type,
      bytes,
      category: field(formData, "category") || "general",
      periodStart: optional(formData, "periodStart"),
      periodEnd: optional(formData, "periodEnd"),
    });
    return "Document uploaded and stored privately.";
  });
}

export async function reviewDocumentAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/documents");
  await finish(path, async () => {
    const { org } = await requirePageContext("documents:review");
    const status = field(formData, "status");
    if (status !== "in_review" && status !== "approved" && status !== "rejected") {
      throw new ValidationError("Invalid review status");
    }
    await reviewDocument(getDb(), org, field(formData, "documentId"), {
      status,
      notes: optional(formData, "notes"),
    });
    return `Document marked ${status.replace("_", " ")}.`;
  });
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/documents");
  await finish(path, async () => {
    const { org } = await requirePageContext("documents:write");
    await deleteDocument(getDb(), org, field(formData, "documentId"));
    return "Document deleted.";
  });
}

export async function createDocumentRequestAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/documents/requests");
  await finish(path, async () => {
    const { org } = await requirePageContext("documents:write");
    await createDocumentRequest(getDb(), org, {
      title: field(formData, "title"),
      description: optional(formData, "description") ?? undefined,
      dueDate: optional(formData, "dueDate"),
      periodStart: optional(formData, "periodStart"),
      periodEnd: optional(formData, "periodEnd"),
    });
    return "Document request created.";
  });
}

export async function fulfilDocumentRequestAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/documents/requests");
  await finish(path, async () => {
    const { org } = await requirePageContext("documents:write");
    await fulfilDocumentRequest(
      getDb(),
      org,
      field(formData, "requestId"),
      field(formData, "documentId"),
    );
    return "Request marked fulfilled.";
  });
}

export async function importTenderAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/tenders/import");
  await finish(path, async () => {
    const { org } = await requirePageContext("tenders:write");
    await importTender(getDb(), org, {
      reference: field(formData, "reference"),
      title: field(formData, "title"),
      buyer: optional(formData, "buyer"),
      description: optional(formData, "description"),
      category: optional(formData, "category"),
      region: optional(formData, "region"),
      budget: optional(formData, "budget"),
      publishedAt: optional(formData, "publishedAt"),
      closesAt: field(formData, "closesAt"),
      sourceName: optional(formData, "sourceName"),
      sourceUrl: field(formData, "sourceUrl"),
    });
    return "Tender imported with its source and verification timestamp.";
  });
}

export async function assessTenderAction(formData: FormData): Promise<void> {
  const tenderId = field(formData, "tenderId");
  const path = `/app/tenders/${tenderId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("tenders:read");
    const result = await assessTenderFit(getDb(), org, tenderId);
    return `Fit assessed at ${result.score}/100. Eligibility still requires checking the official notice.`;
  });
}

export async function createChecklistAction(formData: FormData): Promise<void> {
  const tenderId = field(formData, "tenderId");
  const path = `/app/tenders/${tenderId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("tenders:write");
    await ensureChecklist(getDb(), org, tenderId);
    return "Bid-readiness checklist created.";
  });
}

export async function toggleChecklistItemAction(formData: FormData): Promise<void> {
  const tenderId = field(formData, "tenderId");
  const path = `/app/tenders/${tenderId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("tenders:write");
    await toggleChecklistItem(getDb(), org, field(formData, "itemId"), field(formData, "done") === "true");
    return "Checklist updated.";
  });
}

export async function runReconciliationAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/reconciliation");
  await finish(path, async () => {
    const { org } = await requirePageContext("recon:write");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a CSV or XLSX file");
    if (file.size > maxUploadBytes()) throw new ValidationError("File is too large");
    let mapping: Record<string, string>;
    try {
      mapping = JSON.parse(field(formData, "mapping") || "{}") as Record<string, string>;
    } catch {
      throw new ValidationError("The column mapping could not be read");
    }
    const source = field(formData, "source");
    if (source !== "ebm_sales" && source !== "ebm_purchases") {
      throw new ValidationError("Choose an import type");
    }
    const result = await runReconciliation(getDb(), org, {
      source,
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      mapping: {
        invoiceNumber: mapping.invoiceNumber ?? "",
        amount: mapping.amount ?? "",
        date: mapping.date || undefined,
        counterparty: mapping.counterparty || undefined,
        tax: mapping.tax || undefined,
      },
    });
    return `Imported ${result.rowsTotal} rows: ${result.rowsMatched} matched, ${result.findingsCount} findings. Open the job from the list below.`;
  });
}

export async function reviewFindingAction(formData: FormData): Promise<void> {
  const jobId = field(formData, "jobId");
  const path = `/app/reconciliation/${jobId}`;
  await finish(path, async () => {
    const { org } = await requirePageContext("recon:review");
    const status = field(formData, "status");
    if (status !== "accepted" && status !== "resolved" && status !== "dismissed") {
      throw new ValidationError("Choose a review outcome");
    }
    const { reviewFinding } = await import("@/lib/reconciliation");
    await reviewFinding(getDb(), org, field(formData, "findingId"), {
      status,
      note: optional(formData, "note"),
    });
    return "Finding reviewed and recorded.";
  });
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/team");
  await finish(path, async () => {
    const { org } = await requirePageContext("team:manage");
    const role = field(formData, "role") as InvitableRole;
    if (!["staff", "advisor", "firm_admin"].includes(role)) throw new ValidationError("Invalid role");
    const result = await createMemberInvitation(getDb(), org, {
      email: field(formData, "email"),
      role,
    });
    const rendered = invitationEmailWithToken({
      organizationName: org.orgName,
      role,
      kind: "member",
      token: result.token,
    });
    const delivery = await sendEmail(getDb(), {
      to: field(formData, "email"),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: "team.invitation",
    });
    const link = linksVisibleInUi() ? ` Invite link (development): ${rendered.link}` : "";
    return `Invitation created. ${emailNotice(delivery.status, "Invitation email")}${link}`;
  });
}

export async function grantAdvisorAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/team");
  await finish(path, async () => {
    const { org } = await requirePageContext("team:manage");
    const result = await grantAdvisorAccess(getDb(), org, {
      advisorEmail: field(formData, "advisorEmail"),
      firmOrgId: optional(formData, "firmOrgId"),
    });
    const rendered = invitationEmailWithToken({
      organizationName: org.orgName,
      role: "advisor",
      kind: "advisor",
      token: result.token,
    });
    const delivery = await sendEmail(getDb(), {
      to: field(formData, "advisorEmail"),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: "advisor.invitation",
    });
    const link = linksVisibleInUi() ? ` Invite link (development): ${rendered.link}` : "";
    return `Advisor authorization created (pending acceptance). ${emailNotice(delivery.status, "Advisor invitation email")}${link}`;
  });
}

export async function revokeAdvisorAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/team");
  await finish(path, async () => {
    const { org } = await requirePageContext("team:manage");
    await revokeAdvisorAccess(getDb(), org, field(formData, "accessId"));
    return "Advisor access revoked. Their sessions no longer see this organization.";
  });
}

export async function updateProfileAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/settings");
  await finish(path, async () => {
    const { org } = await requirePageContext("org:manage");
    const db = getDb();
    const legalName = field(formData, "legalName");
    if (legalName.length < 2) throw new ValidationError("Enter the legal business name");
    const keywords = field(formData, "keywords")
      .split(",")
      .map((keyword) => keyword.trim())
      .filter(Boolean)
      .slice(0, 20);
    await db
      .update(businessProfiles)
      .set({
        legalName,
        tradingName: optional(formData, "tradingName"),
        tin: optional(formData, "tin"),
        registrationNumber: optional(formData, "registrationNumber"),
        sector: optional(formData, "sector"),
        city: optional(formData, "city"),
        countryCode: field(formData, "countryCode").toUpperCase() || "RW",
        contactEmail: optional(formData, "contactEmail"),
        contactPhone: optional(formData, "contactPhone"),
        address: optional(formData, "address"),
        keywords,
        updatedAt: new Date(),
      })
      .where(eq(businessProfiles.orgId, org.orgId));
    await db
      .update(organizations)
      .set({ name: field(formData, "organizationName") || legalName, updatedAt: new Date() })
      .where(eq(organizations.id, org.orgId));
    await recordAuditSafe(db, {
      orgId: org.orgId,
      actorUserId: org.actor.user.id,
      action: "organization.profile_updated",
      entityType: "organization",
      entityId: org.orgId,
    });
    revalidatePath("/app", "layout");
    return "Business profile saved.";
  });
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/settings");
  await finish(path, async () => {
    const { actor } = await requirePageContext("org:read");
    await changePassword(
      getDb(),
      actor.user.id,
      field(formData, "currentPassword"),
      field(formData, "newPassword"),
    );
    return "Password changed. Other sessions were signed out.";
  });
}

export async function createTaskAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/tasks");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await createTask(getDb(), org, {
      title: field(formData, "title"),
      description: optional(formData, "description"),
      dueDate: optional(formData, "dueDate"),
      priority: field(formData, "priority") || "normal",
      assigneeUserId: optional(formData, "assigneeUserId"),
      customerId: optional(formData, "customerId"),
      periodStart: optional(formData, "periodStart"),
      periodEnd: optional(formData, "periodEnd"),
    });
    return "Task created.";
  });
}

export async function updateTaskAction(formData: FormData): Promise<void> {
  const taskId = field(formData, "taskId");
  const path = backPath(formData, "/app/tasks");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    const status = field(formData, "status");
    if (!["open", "in_progress", "done", "cancelled"].includes(status)) {
      throw new ValidationError("Invalid task status");
    }
    await updateTask(getDb(), org, taskId, {
      title: field(formData, "title"),
      description: optional(formData, "description"),
      dueDate: optional(formData, "dueDate"),
      priority: field(formData, "priority"),
      assigneeUserId: optional(formData, "assigneeUserId"),
      customerId: optional(formData, "customerId"),
      periodStart: optional(formData, "periodStart"),
      periodEnd: optional(formData, "periodEnd"),
      status: status as "open" | "in_progress" | "done" | "cancelled",
    });
    return "Task updated.";
  });
}

export async function completeTaskAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/tasks");
  await finish(path, async () => {
    const { org } = await requirePageContext("finance:write");
    await completeTask(getDb(), org, field(formData, "taskId"));
    return "Task completed.";
  });
}

export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/notifications");
  await finish(path, async () => {
    const { actor } = await requirePageContext("org:read");
    await markNotificationRead(getDb(), actor.user.id, field(formData, "notificationId"));
    return "Notification marked as read.";
  });
}

export async function markAllNotificationsReadAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/notifications");
  await finish(path, async () => {
    const { actor, org } = await requirePageContext("org:read");
    await markAllNotificationsRead(getDb(), actor.user.id, org.orgId);
    return "All notifications marked as read.";
  });
}

export async function updateNotificationPreferencesAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/notifications");
  await finish(path, async () => {
    const { actor, org } = await requirePageContext("org:read");
    for (const category of NOTIFICATION_CATEGORIES) {
      await setNotificationPreference(getDb(), {
        userId: actor.user.id,
        orgId: org.orgId,
        category,
        inAppEnabled: formData.get(`in_app_${category}`) === "on",
        emailEnabled: formData.get(`email_${category}`) === "on",
      });
    }
    return "Notification preferences saved.";
  });
}

export async function createOrganizationAction(formData: FormData): Promise<void> {
  const path = "/app/settings";
  await finish(path, async () => {
    const { actor } = await requirePageContext("org:read");
    if (!actor.user.emailVerifiedAt) {
      throw new ValidationError("Verify your email address before creating another organization");
    }
    const kind = field(formData, "kind") === "accounting_firm" ? "accounting_firm" : "business";
    const created = await createOrganizationForUser(getDb(), actor.user.id, {
      name: field(formData, "name"),
      kind,
      currency: field(formData, "currency") || "RWF",
    });
    await setActiveOrgCookie(created.orgId);
    revalidatePath("/app", "layout");
    return "Organization created and selected.";
  });
}

export async function saveTenderAction(formData: FormData): Promise<void> {
  const path = backPath(formData, "/app/tenders");
  await finish(path, async () => {
    const { org } = await requirePageContext("tenders:write");
    const saved = field(formData, "saved") === "true";
    await setTenderSaved(getDb(), org, field(formData, "tenderId"), saved);
    return saved ? "Opportunity saved." : "Opportunity removed from saved list.";
  });
}
