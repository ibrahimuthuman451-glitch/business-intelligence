import { and, eq, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { emailOutbox } from "@/db/schema";
import { getEmailTransport, EmailError, type EmailTransport } from ".";

const MAX_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS ?? 5);
const BASE_BACKOFF_SECONDS = Number(process.env.EMAIL_BACKOFF_SECONDS ?? 60);

export type EnqueueInput = {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  kind: string;
  dedupeKey?: string | null;
};

export type DeliveryStatus = "sent" | "queued" | "failed" | "duplicate";

export type DeliveryResult = {
  id: string;
  status: DeliveryStatus;
  error?: string;
};

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function backoffDate(attempts: number): Date {
  const seconds = Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(attempts - 1, 0), 3600);
  return new Date(Date.now() + seconds * 1000);
}

export async function enqueueEmail(db: AppDb, input: EnqueueInput): Promise<{ id: string; duplicate: boolean }> {
  const values = {
    toEmail: normaliseEmail(input.to),
    subject: input.subject.slice(0, 240),
    bodyText: input.text,
    bodyHtml: input.html ?? null,
    kind: input.kind.slice(0, 60),
    dedupeKey: input.dedupeKey ?? null,
  };

  if (values.dedupeKey) {
    const [inserted] = await db
      .insert(emailOutbox)
      .values(values)
      .onConflictDoNothing({ target: emailOutbox.dedupeKey })
      .returning({ id: emailOutbox.id });
    if (inserted) return { id: inserted.id, duplicate: false };
    const [existing] = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.dedupeKey, values.dedupeKey))
      .limit(1);
    if (!existing) throw new Error("Could not enqueue or resolve email");
    return { id: existing.id, duplicate: true };
  }

  const [inserted] = await db.insert(emailOutbox).values(values).returning({ id: emailOutbox.id });
  if (!inserted) throw new Error("Could not enqueue email");
  return { id: inserted.id, duplicate: false };
}

/**
 * Attempts exactly one delivery for an outbox row. The row is claimed with a
 * conditional update so concurrent workers cannot send the same message twice
 * in the same attempt.
 */
export async function deliverOutboxItem(
  db: AppDb,
  id: string,
  transport: EmailTransport = getEmailTransport(),
): Promise<{ status: DeliveryStatus; error?: string }> {
  const [claimed] = await db
    .update(emailOutbox)
    .set({
      status: "sending",
      attempts: sql`${emailOutbox.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "queued")))
    .returning();

  if (!claimed) {
    const [current] = await db
      .select({ status: emailOutbox.status })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, id))
      .limit(1);
    if (current?.status === "sent") return { status: "sent" };
    return { status: "queued" };
  }

  try {
    const result = await transport.send({
      to: claimed.toEmail,
      subject: claimed.subject,
      text: claimed.bodyText,
      html: claimed.bodyHtml ?? undefined,
    });
    await db
      .update(emailOutbox)
      .set({
        status: "sent",
        providerMessageId: result.messageId.slice(0, 200),
        sentAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(emailOutbox.id, id));
    return { status: "sent" };
  } catch (error) {
    const emailError =
      error instanceof EmailError
        ? error
        : new EmailError("Email provider rejected the message", { transient: false });
    const terminal = !emailError.transient || claimed.attempts >= MAX_ATTEMPTS;
    const message = emailError.message.slice(0, 300);
    await db
      .update(emailOutbox)
      .set({
        status: terminal ? "failed" : "queued",
        lastError: message,
        nextAttemptAt: terminal ? claimed.nextAttemptAt : backoffDate(claimed.attempts),
        updatedAt: new Date(),
      })
      .where(eq(emailOutbox.id, id));
    return { status: terminal ? "failed" : "queued", error: message };
  }
}

/** Enqueues and attempts immediate delivery; retries remain in the outbox. */
export async function sendEmail(
  db: AppDb,
  input: EnqueueInput,
): Promise<DeliveryResult> {
  const queued = await enqueueEmail(db, input);
  if (queued.duplicate) {
    const [row] = await db
      .select({ status: emailOutbox.status })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued.id))
      .limit(1);
    if (row?.status === "sent") return { id: queued.id, status: "duplicate" };
    if (row?.status === "failed") return { id: queued.id, status: "failed" };
    return { id: queued.id, status: "queued" };
  }
  try {
    const delivered = await deliverOutboxItem(db, queued.id);
    return { id: queued.id, status: delivered.status, error: delivered.error };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Email is not configured";
    await db
      .update(emailOutbox)
      .set({ status: "failed", lastError: message, updatedAt: new Date() })
      .where(eq(emailOutbox.id, queued.id));
    return { id: queued.id, status: "failed", error: message };
  }
}

export async function processEmailOutbox(
  db: AppDb,
  options: { limit?: number; transport?: EmailTransport; now?: Date } = {},
): Promise<{ processed: number; sent: number; failed: number; queued: number }> {
  const now = options.now ?? new Date();
  let transport: EmailTransport;
  try {
    transport = options.transport ?? getEmailTransport();
  } catch (error) {
    console.warn(
      "Email outbox skipped: transport is not configured",
      error instanceof Error ? error.message : "unknown",
    );
    return { processed: 0, sent: 0, failed: 0, queued: 0 };
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  const due = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "queued"), lte(emailOutbox.nextAttemptAt, now)))
    .orderBy(emailOutbox.nextAttemptAt)
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let queued = 0;
  for (const row of due) {
    const result = await deliverOutboxItem(db, row.id, transport);
    if (result.status === "sent") sent += 1;
    else if (result.status === "failed") failed += 1;
    else queued += 1;
  }
  return { processed: due.length, sent, failed, queued };
}

export async function emailOutboxStatus(db: AppDb): Promise<{
  queued: number;
  failed: number;
  sent: number;
}> {
  const rows = await db
    .select({ status: emailOutbox.status, total: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .groupBy(emailOutbox.status);
  const counts = { queued: 0, failed: 0, sent: 0 };
  for (const row of rows) {
    if (row.status === "sent") counts.sent += Number(row.total);
    else if (row.status === "failed") counts.failed += Number(row.total);
    else counts.queued += Number(row.total);
  }
  return counts;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}
