import { and, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  bidChecklists,
  documentRequests,
  notifications,
  organizations,
  tasks,
  tenderMatches,
  tenders,
} from "@/db/schema";
import { documentRequestEmail, taskAssignedEmail, tenderDeadlineEmail } from "./email/templates";
import { notifyOrgMembers, notifyUsers, orgMemberIds } from "./notifications";
import { appUrl } from "./request";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Whole-day difference based on UTC calendar dates. */
export function daysUntil(target: Date, now: Date): number {
  const targetDay = Date.parse(`${isoDate(target)}T00:00:00Z`);
  const nowDay = Date.parse(`${isoDate(now)}T00:00:00Z`);
  return Math.round((targetDay - nowDay) / 86_400_000);
}

export type ReminderSummary = {
  taskReminders: number;
  documentRequestReminders: number;
  tenderReminders: number;
  emailsQueued: number;
};

/**
 * Generates reminder notifications from persisted state. Date-based dedupe keys
 * make the function idempotent for a given UTC day, so retries and multiple
 * workers cannot spam recipients. Safe to run as often as every hour.
 *
 * Scheduling uses UTC calendar days deliberately; the deployment timezone does
 * not change which records are considered due.
 */
export async function generateReminders(
  db: AppDb,
  options: { now?: Date } = {},
): Promise<ReminderSummary> {
  const now = options.now ?? new Date();
  const today = isoDate(now);
  const soon = isoDate(addDays(now, 3));
  const summary: ReminderSummary = {
    taskReminders: 0,
    documentRequestReminders: 0,
    tenderReminders: 0,
    emailsQueued: 0,
  };

  const orgRows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  const orgNames = new Map(orgRows.map((row) => [row.id, row.name]));

  // Tasks due within three days, including overdue items still open.
  const taskRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        lte(tasks.dueDate, soon),
        inArray(tasks.status, ["open", "in_progress"]),
      ),
    )
    .limit(1000);

  for (const task of taskRows) {
    const recipient = task.assigneeUserId ?? task.createdBy;
    if (!recipient) continue;
    const overdue = (task.dueDate as string) < today;
    const result = await notifyUsers(db, {
      orgId: task.orgId,
      userIds: [recipient],
      category: "tasks",
      title: overdue ? `Overdue task: ${task.title}` : `Task due soon: ${task.title}`,
      body: `Due ${task.dueDate}.`,
      href: `/app/tasks?task=${task.id}`,
      dedupeKey: `task-reminder:${task.id}:${today}`,
      email: () =>
        taskAssignedEmail({
          organizationName: orgNames.get(task.orgId) ?? "Your organization",
          title: task.title,
          dueDate: task.dueDate,
          link: `${appUrl()}/app/tasks?task=${task.id}`,
        }),
    });
    summary.taskReminders += result.inApp;
    summary.emailsQueued += result.emailsQueued;
  }

  // Open document requests due within three days.
  const requestRows = await db
    .select()
    .from(documentRequests)
    .where(
      and(
        eq(documentRequests.status, "open"),
        isNotNull(documentRequests.dueDate),
        lte(documentRequests.dueDate, soon),
      ),
    )
    .limit(500);

  for (const request of requestRows) {
    const result = await notifyOrgMembers(db, request.orgId, {
      category: "documents",
      title: `Document request due: ${request.title}`,
      body: request.dueDate ? `Due ${request.dueDate}.` : null,
      href: "/app/documents/requests",
      dedupeKey: `document-request-reminder:${request.id}:${today}`,
      excludeUserIds: [request.requestedBy],
      email: () =>
        documentRequestEmail({
          organizationName: orgNames.get(request.orgId) ?? "Your organization",
          title: request.title,
          dueDate: request.dueDate,
          link: `${appUrl()}/app/documents/requests`,
        }),
    });
    summary.documentRequestReminders += result.inApp;
    summary.emailsQueued += result.emailsQueued;
  }

  // Tender deadlines in the next week: organization-owned notices plus sample
  // notices that the organization explicitly saved or started a checklist for.
  const tenderRows = await db
    .select()
    .from(tenders)
    .where(
      and(
        gte(tenders.closesAt, now),
        lte(tenders.closesAt, addDays(now, 7)),
      ),
    )
    .limit(500);

  for (const tender of tenderRows) {
    const daysLeft = daysUntil(tender.closesAt, now);
    let orgIds: string[] = [];
    if (tender.orgId) {
      orgIds = [tender.orgId];
    } else {
      const savedRows = await db
        .select({ orgId: tenderMatches.orgId })
        .from(tenderMatches)
        .where(and(eq(tenderMatches.tenderId, tender.id), eq(tenderMatches.saved, true)));
      const checklistRows = await db
        .select({ orgId: bidChecklists.orgId })
        .from(bidChecklists)
        .where(eq(bidChecklists.tenderId, tender.id));
      orgIds = [...new Set([...savedRows, ...checklistRows].map((row) => row.orgId))];
    }

    for (const orgId of orgIds) {
      const userIds = await orgMemberIds(db, orgId);
      const result = await notifyUsers(db, {
        orgId,
        userIds,
        category: "tenders",
        title: `Tender closes in ${daysLeft} day${daysLeft === 1 ? "" : "s"}: ${tender.title}`,
        body: `Recorded closing date ${tender.closesAt.toISOString()}. Verify it on the official notice.`,
        href: `/app/tenders/${tender.id}`,
        dedupeKey: `tender-reminder:${tender.id}:${orgId}:${today}`,
        email: () =>
          tenderDeadlineEmail({
            organizationName: orgNames.get(orgId) ?? "Your organization",
            title: tender.title,
            closesAt: tender.closesAt.toISOString().slice(0, 16).replace("T", " ") + " UTC",
            daysLeft,
            link: `${appUrl()}/app/tenders/${tender.id}`,
          }),
      });
      summary.tenderReminders += result.inApp;
      summary.emailsQueued += result.emailsQueued;
    }
  }

  return summary;
}

export async function purgeOldNotifications(db: AppDb, olderThanDays = 180): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const deleted = await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.readAt, cutoff)))
    .returning({ id: notifications.id });
  return deleted.length;
}
