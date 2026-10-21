import type { AppDb } from "@/db/client";
import { auditEvents } from "@/db/schema";

export type AuditInput = {
  orgId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
};

export async function recordAudit(db: AppDb, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: input.orgId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? null,
    ipAddress: input.ipAddress ?? null,
  });
}

/** Audit failures must not break user-facing flows, but must be visible in logs. */
export async function recordAuditSafe(db: AppDb, input: AuditInput): Promise<void> {
  try {
    await recordAudit(db, input);
  } catch (error) {
    console.error("Failed to write audit event", input.action, error);
  }
}
