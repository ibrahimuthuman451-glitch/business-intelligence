import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { documentRequests, emailOutbox, jobRuns, memberships, organizations, tasks } from "@/db/schema";
import { createOrg, createTestContext, reloadActor, type TestContext } from "./helpers";
import { authorizeOrg } from "@/lib/authz";
import { completeTask, createTask, listTasks, updateTask } from "@/lib/tasks";
import {
  getNotificationPreference,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
  unreadNotificationCount,
} from "@/lib/notifications";
import { daysUntil, generateReminders } from "@/lib/reminders";
import { runScheduledJobs } from "@/lib/jobs";
import { setEmailTransportForTesting, type EmailMessage, type EmailTransport, type SendResult } from "@/lib/email";
import { createDocumentRequest } from "@/lib/documents";
import { importTender } from "@/lib/tenders";

let context: TestContext;

class QuietTransport implements EmailTransport {
  readonly name = "quiet";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.messages.push(message);
    return { messageId: `quiet-${this.messages.length}`, accepted: [message.to] };
  }
}

let transport: QuietTransport;

beforeAll(async () => {
  context = await createTestContext();
});

beforeEach(() => {
  transport = new QuietTransport();
  setEmailTransportForTesting(transport);
});

afterEach(() => {
  setEmailTransportForTesting(null);
});

afterAll(async () => {
  await context.cleanup();
});

async function demoOrg(email: string, orgName: string) {
  const org = await createOrg(context.db, { email, orgName });
  await context.db.update(organizations).set({ plan: "demo" }).where(eq(organizations.id, org.orgId));
  return org;
}

async function addStaff(ownerOrgId: string, email: string, name: string) {
  const staff = await createOrg(context.db, { email, orgName: `${name} Personal` });
  await context.db.insert(memberships).values({
    orgId: ownerOrgId,
    userId: staff.userId,
    role: "staff",
    status: "active",
  });
  const actor = await reloadActor(context.db, staff.userId);
  const ctx = await authorizeOrg(context.db, actor, ownerOrgId, "org:read");
  return { ...staff, ctx, actor };
}

describe("tasks", () => {
  it("creates, assigns, updates and completes a task with an in-app and email notification", async () => {
    const owner = await demoOrg("task-owner@example.com", "Task Owner Co");
    const staff = await addStaff(owner.orgId, "task-staff@example.com", "Task Staff");

    const created = await createTask(context.db, owner.ctx, {
      title: "Prepare March reconciliation",
      description: "Match invoices to the report",
      dueDate: "2026-06-20",
      priority: "high",
      assigneeUserId: staff.userId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
    });

    const notificationsForStaff = await listNotifications(context.db, staff.userId, owner.orgId);
    expect(notificationsForStaff).toHaveLength(1);
    expect(notificationsForStaff[0]?.title).toContain("Task assigned");
    expect(await unreadNotificationCount(context.db, staff.userId, owner.orgId)).toBe(1);
    expect(transport.messages.some((message) => message.to === "task-staff@example.com")).toBe(true);

    const tasks = await listTasks(context.db, staff.ctx, { assignee: "me", status: "open" });
    expect(tasks.map((task) => task.id)).toContain(created.id);

    await updateTask(context.db, staff.ctx, created.id, {
      title: "Prepare March reconciliation (updated)",
      priority: "urgent",
      dueDate: "2026-06-18",
      assigneeUserId: staff.userId,
      status: "in_progress",
    });
    await completeTask(context.db, staff.ctx, created.id);
    const completed = await listTasks(context.db, owner.ctx, { status: "done" });
    expect(completed[0]?.id).toBe(created.id);
    expect(completed[0]?.completedAt).toBeInstanceOf(Date);
  });

  it("filters overdue tasks by UTC calendar date", async () => {
    const owner = await demoOrg("overdue-owner@example.com", "Overdue Co");
    const created = await createTask(context.db, owner.ctx, {
      title: "Overdue task",
      dueDate: "2020-01-01",
      priority: "normal",
    });
    const overdue = await listTasks(context.db, owner.ctx, { status: "overdue" });
    expect(overdue.map((task) => task.id)).toContain(created.id);
    expect(overdue[0]?.overdue).toBe(true);
  });

  it("rejects assignment to a user outside the organization", async () => {
    const owner = await demoOrg("assign-owner@example.com", "Assign Co");
    const outsider = await createOrg(context.db, { email: "assign-outsider@example.com", orgName: "Outsider" });
    await expect(
      createTask(context.db, owner.ctx, { title: "Invalid assignee", assigneeUserId: outsider.userId }),
    ).rejects.toThrow(/not an active member/i);
  });

  it("does not notify a user who disabled the task category", async () => {
    const owner = await demoOrg("pref-owner@example.com", "Pref Co");
    const staff = await addStaff(owner.orgId, "pref-staff@example.com", "Pref Staff");
    await setNotificationPreference(context.db, {
      userId: staff.userId,
      orgId: owner.orgId,
      category: "tasks",
      inAppEnabled: false,
      emailEnabled: false,
    });
    await createTask(context.db, owner.ctx, {
      title: "No notification task",
      assigneeUserId: staff.userId,
    });
    expect(await listNotifications(context.db, staff.userId, owner.orgId)).toHaveLength(0);
    expect(transport.messages.filter((message) => message.to === "pref-staff@example.com")).toHaveLength(0);
    const preference = await getNotificationPreference(context.db, {
      userId: staff.userId,
      orgId: owner.orgId,
      category: "tasks",
    });
    expect(preference.emailEnabled).toBe(false);
  });

  it("marks notifications read for the owning user only", async () => {
    const owner = await demoOrg("read-owner@example.com", "Read Co");
    const staff = await addStaff(owner.orgId, "read-staff@example.com", "Read Staff");
    await createTask(context.db, owner.ctx, { title: "Read me", assigneeUserId: staff.userId });
    const [notification] = await listNotifications(context.db, staff.userId, owner.orgId);
    await markNotificationRead(context.db, owner.userId, notification!.id);
    expect(await unreadNotificationCount(context.db, staff.userId, owner.orgId)).toBe(1);
    await markNotificationRead(context.db, staff.userId, notification!.id);
    expect(await unreadNotificationCount(context.db, staff.userId, owner.orgId)).toBe(0);

    await createTask(context.db, owner.ctx, { title: "Second", assigneeUserId: staff.userId });
    await markAllNotificationsRead(context.db, staff.userId, owner.orgId);
    expect(await unreadNotificationCount(context.db, staff.userId, owner.orgId)).toBe(0);
  });
});

describe("reminders and scheduled jobs", () => {
  it("computes whole calendar days in UTC, independent of server timezone", () => {
    expect(
      daysUntil(new Date("2026-06-16T00:30:00Z"), new Date("2026-06-15T23:30:00Z")),
    ).toBe(1);
    expect(
      daysUntil(new Date("2026-06-15T23:59:00Z"), new Date("2026-06-15T00:01:00Z")),
    ).toBe(0);
  });

  it("generates deduplicated task, document-request and tender reminders", async () => {
    const owner = await demoOrg("reminder-owner@example.com", "Reminder Co");
    const staff = await addStaff(owner.orgId, "reminder-staff@example.com", "Reminder Staff");
    const now = new Date("2026-06-15T09:00:00Z");

    // The reminder generator intentionally scans every organization; close out
    // records created by earlier tests so assertions are deterministic.
    await context.db.update(tasks).set({ status: "done" });
    await context.db.update(documentRequests).set({ status: "cancelled" });

    await createTask(context.db, owner.ctx, {
      title: "Reminder task",
      dueDate: "2026-06-16",
      assigneeUserId: owner.userId,
    });
    await createDocumentRequest(context.db, owner.ctx, {
      title: "Reminder document",
      dueDate: "2026-06-17",
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    await importTender(context.db, owner.ctx, {
      reference: "REMINDER-TENDER-1",
      title: "Reminder tender",
      closesAt: "2026-06-18T10:00:00Z",
      sourceUrl: "https://example.org/notices/reminder-1",
    });

    const first = await generateReminders(context.db, { now });
    expect(first.taskReminders).toBe(1);
    expect(first.documentRequestReminders).toBeGreaterThanOrEqual(1);
    expect(first.tenderReminders).toBe(2);

    const second = await generateReminders(context.db, { now });
    expect(second.taskReminders).toBe(0);
    expect(second.documentRequestReminders).toBe(0);
    expect(second.tenderReminders).toBe(0);

    const staffNotifications = await listNotifications(context.db, staff.userId, owner.orgId);
    expect(staffNotifications.length).toBeGreaterThanOrEqual(2);
    const ownerNotifications = await listNotifications(context.db, owner.userId, owner.orgId);
    expect(ownerNotifications.filter((item) => item.type === "tasks")).toHaveLength(1);

    const nextDay = await generateReminders(context.db, {
      now: new Date("2026-06-16T09:00:00Z"),
    });
    expect(nextDay.taskReminders).toBe(1);
    const ownerTasks = await listNotifications(context.db, owner.userId, owner.orgId);
    expect(ownerTasks.filter((item) => item.type === "tasks")).toHaveLength(2);
  });

  it("runs the persisted job pipeline, records the run and recovers stale sends", async () => {
    const owner = await demoOrg("job-owner@example.com", "Job Co");
    await createTask(context.db, owner.ctx, {
      title: "Job reminder",
      dueDate: new Date().toISOString().slice(0, 10),
      assigneeUserId: owner.userId,
    });

    const [stale] = await context.db
      .insert(emailOutbox)
      .values({
        toEmail: "stale@example.com",
        subject: "Stale",
        bodyText: "Recovered",
        kind: "test.stale",
        status: "sending",
      })
      .returning({ id: emailOutbox.id });
    await context.db
      .update(emailOutbox)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(emailOutbox.id, stale!.id));

    const result = await runScheduledJobs(getDb(), { transport });
    expect(result.summary.recoveredEmails).toBeGreaterThanOrEqual(1);
    expect(result.summary.emails.sent).toBeGreaterThanOrEqual(1);

    const [run] = await context.db.select().from(jobRuns).where(eq(jobRuns.id, result.runId));
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBeTruthy();

    const [recovered] = await context.db.select().from(emailOutbox).where(eq(emailOutbox.id, stale!.id));
    expect(recovered?.status).toBe("sent");
  });

  it("never sends reminders for completed tasks or cancelled document requests", async () => {
    const owner = await demoOrg("skip-owner@example.com", "Skip Co");
    const now = new Date("2026-06-15T09:00:00Z");
    const created = await createTask(context.db, owner.ctx, {
      title: "Already done",
      dueDate: "2026-06-15",
      assigneeUserId: owner.userId,
    });
    await completeTask(context.db, owner.ctx, created.id);
    const request = await createDocumentRequest(context.db, owner.ctx, {
      title: "Cancelled request",
      dueDate: "2026-06-16",
    });
    await context.db
      .update(documentRequests)
      .set({ status: "cancelled" })
      .where(eq(documentRequests.id, request.id));

    const result = await generateReminders(context.db, { now });
    expect(result.taskReminders).toBe(0);
    expect(result.documentRequestReminders).toBe(0);
  });
});
