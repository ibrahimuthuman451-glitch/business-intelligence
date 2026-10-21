import { and, count, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { documentRequests, documents, subscriptionEntitlements } from "@/db/schema";
import { recordAuditSafe } from "./audit";
import { assertSameOrg, type OrgContext } from "./authz";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { deleteUpload, readUpload, saveUpload, validateUpload } from "./storage";

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
  const [entitlement] = await db
    .select({
      enabled: subscriptionEntitlements.enabled,
      limitValue: subscriptionEntitlements.limitValue,
    })
    .from(subscriptionEntitlements)
    .where(
      and(
        eq(subscriptionEntitlements.orgId, ctx.orgId),
        eq(subscriptionEntitlements.feature, "documents"),
      ),
    )
    .limit(1);
  if (entitlement && !entitlement.enabled) {
    throw new AppError("Document storage is not enabled for your plan", 402, "entitlement_required");
  }
  if (entitlement?.limitValue != null) {
    const [row] = await db
      .select({ total: count() })
      .from(documents)
      .where(eq(documents.orgId, ctx.orgId));
    if (Number(row?.total ?? 0) >= entitlement.limitValue) {
      throw new AppError(
        `Your plan allows ${entitlement.limitValue} documents. Remove files or upgrade to continue.`,
        402,
        "entitlement_limit",
      );
    }
  }

  const category = input.category ?? "general";
  if (!CATEGORIES.has(category)) throw new ValidationError("Invalid document category");
  if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) {
    throw new ValidationError("Period start must be before period end");
  }

  const validated = validateUpload(input);
  const storageKey = await saveUpload(ctx.orgId, input.bytes, validated.extension);

  try {
    const [row] = await db
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
      })
      .returning({ id: documents.id });
    if (!row) throw new AppError("Could not save document", 500);

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
    console.error("Could not remove stored document", row.storageKey, error);
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
  await getDocumentRecord(db, ctx, documentId);
  const [request] = await db
    .select({ id: documentRequests.id })
    .from(documentRequests)
    .where(and(eq(documentRequests.id, requestId), eq(documentRequests.orgId, ctx.orgId)))
    .limit(1);
  if (!request) throw new NotFoundError("Document request not found");

  await db
    .update(documentRequests)
    .set({ status: "fulfilled", documentId, updatedAt: new Date() })
    .where(and(eq(documentRequests.id, request.id), eq(documentRequests.orgId, ctx.orgId)));

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

