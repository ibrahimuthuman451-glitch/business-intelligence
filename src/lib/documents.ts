import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { documentRequests, documents } from "@/db/schema";
import { recordAuditSafe } from "./audit";
import { assertSameOrg, type OrgContext } from "./authz";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { deleteUpload, readUpload, saveUpload, validateUpload } from "./storage";
import { notifyOrgMembers, notifyUsers } from "./notifications";
import { documentFulfilledEmail, documentRequestEmail, documentReviewedEmail } from "./email/templates";
import { appUrl } from "./request";
import { logServerError } from "./logger";
import { assertEntitlement, withOrgQuota } from "./entitlements";
import { consumeRateLimit } from "./rate-limit";
import { scanUpload } from "./malware";

export type UploadDocumentInput = {
  filename: string;
  declaredMimeType?: string | null;
  bytes: Buffer;
  category?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
};

const CATEGORIES = new Set(["general", "sales", "purchases", "payroll", "tax", "bank", "contract"]);

export async function createDocument(
  db: AppDb,
  ctx: OrgContext,
  input: UploadDocumentInput,
  meta: { ipAddress?: string | null } = {},
): Promise<{ id: string }> {
  if (!ctx.permissions.includes("documents:write")) throw new ForbiddenError();

  const category = input.category ?? "general";
  if (!CATEGORIES.has(category)) throw new ValidationError("Invalid document category");
  if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) {
    throw new ValidationError("Period start must be before period end");
  }

  const validated = validateUpload(input);
  const scan = await scanUpload(input.bytes, validated.safeFilename);
  const storageKey = await saveUpload(ctx.orgId, input.bytes, validated.extension, validated.mimeType);

  try {
    const row = await withOrgQuota(db, ctx.orgId, async (tx) => {
      await assertEntitlement(tx, ctx.orgId, "documents_count", 1);
      await assertEntitlement(tx, ctx.orgId, "document_storage_bytes", validated.sizeBytes);
      const [inserted] = await tx
        .insert(documents)
        .values({
          orgId: ctx.orgId,
          uploadedBy: ctx.actor.user.id,
          originalFilename: validated.safeFilename,
          storageKey,
          mimeType: validated.mimeType,
          sizeBytes: validated.sizeBytes,
          sha256: validated.sha256,
          category,
          periodStart: input.periodStart || null,
          periodEnd: input.periodEnd || null,
          scanStatus: scan.status,
          scanDetails: scan.detail,
          quarantinedAt: scan.status === "infected" ? new Date() : null,
        })
        .returning({ id: documents.id });
      if (!inserted) throw new AppError("Could not save document", 500);
      return inserted;
    });

    await recordAuditSafe(db, {
      orgId: ctx.orgId,
      actorUserId: ctx.actor.user.id,
      actorEmail: ctx.actor.user.email,
      action: "document.uploaded",
      entityType: "document",
      entityId: row.id,
      metadata: {
        filename: validated.safeFilename,
        sizeBytes: validated.sizeBytes,
        sha256: validated.sha256,
      },
      ipAddress: meta.ipAddress,
    });
    return { id: row.id };
  } catch (error) {
    await deleteUpload(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function listDocuments(
  db: AppDb,
  orgId: string,
  filters: { q?: string; status?: string; category?: string } = {},
) {
  const conditions = [eq(documents.orgId, orgId)];
  if (filters.q) conditions.push(ilike(documents.originalFilename, `%${filters.q}%`));
  if (filters.status) conditions.push(eq(documents.status, filters.status as "uploaded"));
  if (filters.category) conditions.push(eq(documents.category, filters.category));
  return db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}

/** Authorizes the org, then loads the document with an org constraint (IDOR guard). */
export async function getDocumentRecord(db: AppDb, ctx: OrgContext, documentId: string) {
  if (!ctx.permissions.includes("documents:read")) throw new ForbiddenError();
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId)))
    .limit(1);
  if (!row) throw new NotFoundError("Document not found");
  assertSameOrg(row.orgId, ctx.orgId);
  return row;
}

export async function readAuthorizedDocument(
  db: AppDb,
  ctx: OrgContext,
  documentId: string,
  meta: { ipAddress?: string | null } = {},
): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
  const row = await getDocumentRecord(db, ctx, documentId);
  if (row.scanStatus === "infected" || row.quarantinedAt) {
    throw new ForbiddenError("This document is quarantined and cannot be downloaded");
  }
  const bytes = await readUpload(row.storageKey);
  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: "document.downloaded",
    entityType: "document",
    entityId: row.id,
    ipAddress: meta.ipAddress,
  });
  return { filename: row.originalFilename, mimeType: row.mimeType, bytes };
}

export async function reviewDocument(
  db: AppDb,
  ctx: OrgContext,
  documentId: string,
  input: { status: "in_review" | "approved" | "rejected"; notes?: string | null },
): Promise<void> {
  if (!ctx.permissions.includes("documents:review")) throw new ForbiddenError();
  const row = await getDocumentRecord(db, ctx, documentId);
  await db
    .update(documents)
    .set({
      status: input.status,
      reviewNotes: input.notes?.slice(0, 2000) ?? null,
      reviewerId: ctx.actor.user.id,
      reviewedAt: new Date(),
    })
    .where(and(eq(documents.id, row.id), eq(documents.orgId, ctx.orgId)));

  if (row.uploadedBy !== ctx.actor.user.id) {
    await notifyUsers(db, {
      orgId: ctx.orgId,
      userIds: [row.uploadedBy],
      category: "reviews",
      title: `Document ${input.status.replace("_", " ")}: ${row.originalFilename}`,
      body: input.notes ?? null,
      href: "/app/documents",
      dedupeKey: `document-review:${row.id}:${input.status}:${Date.now()}`,
      email: () =>
        documentReviewedEmail({
          organizationName: ctx.orgName,
          filename: row.originalFilename,
          status: input.status,
          note: input.notes ?? null,
          link: `${appUrl()}/app/documents`,
        }),
    }).catch((error) => {
      logServerError("document_review_notification_failed", error);
    });
  }

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: `document.${input.status}`,
    entityType: "document",
    entityId: row.id,
    metadata: { notes: input.notes ?? null },
  });
}

export async function deleteDocument(db: AppDb, ctx: OrgContext, documentId: string): Promise<void> {
  if (!ctx.permissions.includes("documents:write")) throw new ForbiddenError();
  const row = await getDocumentRecord(db, ctx, documentId);
  await db.delete(documents).where(and(eq(documents.id, row.id), eq(documents.orgId, ctx.orgId)));
  await deleteUpload(row.storageKey).catch((error) => {
    logServerError("document_storage_delete_failed", error, { documentId: row.id });
  });
  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: "document.deleted",
    entityType: "document",
    entityId: row.id,
    metadata: { filename: row.originalFilename },
  });
}

/* ----------------------------- Requests ----------------------------- */

export async function createDocumentRequest(
  db: AppDb,
  ctx: OrgContext,
  input: {
    title: string;
    description?: string;
    dueDate?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<{ id: string }> {
  if (!ctx.permissions.includes("documents:write")) throw new ForbiddenError();
  if (input.title.trim().length < 3) throw new ValidationError("Enter a request title");
  const rate = await consumeRateLimit(db, {
    bucket: "document_requests",
    key: ctx.orgId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rate.allowed) {
    throw new AppError("Too many document requests. Try again later.", 429, "rate_limited");
  }
  const [row] = await db
    .insert(documentRequests)
    .values({
      orgId: ctx.orgId,
      requestedBy: ctx.actor.user.id,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      dueDate: input.dueDate || null,
      periodStart: input.periodStart || null,
      periodEnd: input.periodEnd || null,
    })
    .returning({ id: documentRequests.id });
  if (!row) throw new AppError("Could not create request", 500);

  await notifyOrgMembers(db, ctx.orgId, {
    category: "documents",
    title: `Document requested: ${input.title.trim()}`,
    body: input.dueDate ? `Due ${input.dueDate}.` : "No due date set.",
    href: "/app/documents/requests",
    dedupeKey: `document-request:${row.id}`,
    excludeUserIds: [ctx.actor.user.id],
    email: () =>
      documentRequestEmail({
        organizationName: ctx.orgName,
        title: input.title.trim(),
        dueDate: input.dueDate ?? null,
        link: `${appUrl()}/app/documents/requests`,
      }),
  }).catch((error) => {
    logServerError("document_request_notification_failed", error);
  });

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "document_request.created",
    entityType: "document_request",
    entityId: row.id,
  });
  return row;
}

export async function listDocumentRequests(db: AppDb, orgId: string) {
  return db
    .select()
    .from(documentRequests)
    .where(eq(documentRequests.orgId, orgId))
    .orderBy(desc(documentRequests.createdAt))
    .limit(100);
}

export async function fulfilDocumentRequest(
  db: AppDb,
  ctx: OrgContext,
  requestId: string,
  documentId: string,
): Promise<void> {
  if (!ctx.permissions.includes("documents:write")) throw new ForbiddenError();
  const documentRow = await getDocumentRecord(db, ctx, documentId);
  const [request] = await db
    .select({
      id: documentRequests.id,
      title: documentRequests.title,
      requestedBy: documentRequests.requestedBy,
    })
    .from(documentRequests)
    .where(and(eq(documentRequests.id, requestId), eq(documentRequests.orgId, ctx.orgId)))
    .limit(1);
  if (!request) throw new NotFoundError("Document request not found");

  await db
    .update(documentRequests)
    .set({ status: "fulfilled", documentId, updatedAt: new Date() })
    .where(and(eq(documentRequests.id, request.id), eq(documentRequests.orgId, ctx.orgId)));

  if (request.requestedBy !== ctx.actor.user.id) {
    await notifyUsers(db, {
      orgId: ctx.orgId,
      userIds: [request.requestedBy],
      category: "documents",
      title: `Document request fulfilled: ${request.title}`,
      body: `${documentRow.originalFilename} was uploaded.`,
      href: "/app/documents",
      dedupeKey: `document-request-fulfilled:${request.id}`,
      email: () =>
        documentFulfilledEmail({
          organizationName: ctx.orgName,
          title: request.title,
          filename: documentRow.originalFilename,
          link: `${appUrl()}/app/documents`,
        }),
    }).catch((error) => {
      logServerError("document_fulfilled_notification_failed", error);
    });
  }

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "document_request.fulfilled",
    entityType: "document_request",
    entityId: request.id,
    metadata: { documentId },
  });
}

/** Documents whose reporting period overlaps the given range. */
export async function documentsForPeriod(db: AppDb, orgId: string, start: string, end: string) {
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.orgId, orgId),
        lte(documents.periodStart, end),
        gte(documents.periodEnd, start),
        sql`${documents.periodStart} is not null and ${documents.periodEnd} is not null`,
      ),
    )
    .orderBy(desc(documents.createdAt));
}

