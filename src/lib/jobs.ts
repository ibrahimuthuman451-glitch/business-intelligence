import { and, eq, lt } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { emailOutbox, jobRuns } from "@/db/schema";
import { processEmailOutbox, type DeliveryStatus } from "./email/outbox";
import type { EmailTransport } from "./email/transport";
import { pruneRateLimits } from "./rate-limit";
import { generateReminders, purgeOldNotifications, type ReminderSummary } from "./reminders";

export type JobSummary = {
  reminders: ReminderSummary;
  emails: { processed: number; sent: number; failed: number; queued: number };
  recoveredEmails: number;
  prunedRateLimits: number;
  purgedNotifications: number;
};

/**
 * The single scheduled entry point. All state is persisted in PostgreSQL, so
 * restarts cannot lose work. Invoke it from cron/systemd/GitHub Actions via
 * `npm run jobs:run` or the authenticated POST /api/jobs/run endpoint.
 */
export async function runScheduledJobs(
  db: AppDb,
  options: { now?: Date; transport?: EmailTransport } = {},
): Promise<{ runId: string; summary: JobSummary }> {
  const now = options.now ?? new Date();
  const [run] = await db
    .insert(jobRuns)
    .values({ name: "scheduled", status: "running" })
    .returning({ id: jobRuns.id });
  if (!run) throw new Error("Could not record job run");

  try {
    // Recover messages whose worker died after claiming them.
    const staleCutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const recovered = await db
      .update(emailOutbox)
      .set({ status: "queued", lastError: "Recovered from interrupted delivery", updatedAt: now })
      .where(and(eq(emailOutbox.status, "sending"), lt(emailOutbox.updatedAt, staleCutoff)))
      .returning({ id: emailOutbox.id });

    const reminders = await generateReminders(db, { now });
    const emails = await processEmailOutbox(db, { now, transport: options.transport, limit: 50 });
    const prunedRateLimits = await pruneRateLimits(db);
    const purgedNotifications = await purgeOldNotifications(db);

    const summary: JobSummary = {
      reminders,
      emails,
      recoveredEmails: recovered.length,
      prunedRateLimits,
      purgedNotifications,
    };

    await db
      .update(jobRuns)
      .set({ status: "completed", summary: summary as unknown as Record<string, unknown>, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id));
    return { runId: run.id, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Job failure";
    await db
      .update(jobRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id));
    throw error;
  }
}

export type { DeliveryStatus };
