import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  memberships,
  notificationPreferences,
  notifications,
  organizations,
  users,
} from "@/db/schema";
import { maskEmail, sendEmail } from "./email/outbox";
import type { RenderedEmail } from "./email/templates";
import { appUrl } from "./request";

export const NOTIFICATION_CATEGORIES = ["documents", "tasks", "tenders", "reviews"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export async function getNotificationPreference(
  db: AppDb,
  input: { userId: string; orgId: string; category: NotificationCategory },
): Promise<{ inAppEnabled: boolean; emailEnabled: boolean }> {
  const [row] = await db
    .select({
      inAppEnabled: notificationPreferences.inAppEnabled,
      emailEnabled: notificationPreferences.emailEnabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, input.userId),
        eq(notificationPreferences.orgId, input.orgId),
        eq(notificationPreferences.category, input.category),
      ),
    )
    .limit(1);
  return row ?? { inAppEnabled: true, emailEnabled: true };
}

export async function setNotificationPreference(
  db: AppDb,
  input: {
    userId: string;
    orgId: string;
    category: NotificationCategory;
    inAppEnabled: boolean;
    emailEnabled: boolean;
  },
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      category: input.category,
      inAppEnabled: input.inAppEnabled,
      emailEnabled: input.emailEnabled,
    })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.userId,
        notificationPreferences.orgId,
        notificationPreferences.category,
      ],
      set: { inAppEnabled: input.inAppEnabled, emailEnabled: input.emailEnabled, updatedAt: new Date() },
    });
}

export type NotifyInput = {
  orgId: string;
  userIds: string[];
  category: NotificationCategory;
  title: string;
  body?: string | null;
  href?: string | null;
  dedupeKey: string;
  email?: (recipient: { email: string; name: string }) => RenderedEmail | null;
  emailDedupeSuffix?: string;
};

/**
 * Creates in-app notifications (deduplicated per user/key) and enqueues email
 * when the recipient has not disabled that category. Delivery failures never
 * roll back the underlying business operation.
 */
export async function notifyUsers(
  db: AppDb,
  input: NotifyInput,
): Promise<{ inApp: number; emailsQueued: number }> {
  if (input.userIds.length === 0) return { inApp: 0, emailsQueued: 0 };
  const recipients = await db
    .select({ id: users.id, email: users.email, name: users.name, disabledAt: users.disabledAt })
    .from(users)
    .where(inArray(users.id, [...new Set(input.userIds)]));

  let inApp = 0;
  let emailsQueued = 0;
  for (const recipient of recipients) {
    if (recipient.disabledAt) continue;
    const preference = await getNotificationPreference(db, {
      userId: recipient.id,
      orgId: input.orgId,
      category: input.category,
    });

    if (preference.inAppEnabled) {
      const [inserted] = await db
        .insert(notifications)
        .values({
          orgId: input.orgId,
          userId: recipient.id,
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 2000) ?? null,
          href: input.href ?? null,
          type: input.category,
          dedupeKey: `${input.dedupeKey}:${recipient.id}`,
        })
        .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
        .returning({ id: notifications.id });
      if (inserted) inApp += 1;
    }

    if (preference.emailEnabled && input.email) {
      const rendered = input.email({ email: recipient.email, name: recipient.name });
      if (rendered) {
        try {
          await sendEmail(db, {
            to: recipient.email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            kind: `notification.${input.category}`,
            dedupeKey: `email:${input.dedupeKey}:${input.emailDedupeSuffix ?? ""}:${recipient.id}`,
          });
          emailsQueued += 1;
        } catch (error) {
          console.error(
            "Notification email could not be queued",
            input.category,
            maskEmail(recipient.email),
            error instanceof Error ? error.message : "unknown",
          );
        }
      }
    }
  }
  return { inApp, emailsQueued };
}

export async function orgMemberIds(
  db: AppDb,
  orgId: string,
  options: { exclude?: string[] } = {},
): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")));
  const exclude = new Set(options.exclude ?? []);
  return rows.map((row) => row.userId).filter((id) => !exclude.has(id));
}

export async function notifyOrgMembers(
  db: AppDb,
  orgId: string,
  input: Omit<NotifyInput, "orgId" | "userIds"> & { excludeUserIds?: string[] },
): Promise<{ inApp: number; emailsQueued: number }> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const userIds = await orgMemberIds(db, orgId, { exclude: input.excludeUserIds });
  return notifyUsers(db, {
    ...input,
    orgId,
    userIds,
    title: input.title.replace("{organization}", org?.name ?? "your organization"),
  });
}

export async function listNotifications(db: AppDb, userId: string, orgId: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.orgId, orgId)))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
}

export async function unreadNotificationCount(
  db: AppDb,
  userId: string,
  orgId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.orgId, orgId),
        isNull(notifications.readAt),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function markNotificationRead(
  db: AppDb,
  userId: string,
  notificationId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
}

export async function markAllNotificationsRead(db: AppDb, userId: string, orgId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.orgId, orgId),
        isNull(notifications.readAt),
      ),
    );
}

export function notificationLink(path: string): string {
  return `${appUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
