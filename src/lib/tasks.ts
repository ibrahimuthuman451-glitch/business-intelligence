import { and, asc, eq, ilike, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { customers, memberships, tasks, users } from "@/db/schema";
import { recordAuditSafe } from "./audit";
import type { OrgContext } from "./authz";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { notifyUsers, orgMemberIds } from "./notifications";
import { taskAssignedEmail } from "./email/templates";
import { appUrl } from "./request";

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TaskInput = {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: string;
  assigneeUserId?: string | null;
  customerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
};

function assertWrite(ctx: OrgContext): void {
  if (!ctx.permissions.includes("finance:write")) throw new ForbiddenError();
}

function assertRead(ctx: OrgContext): void {
  if (!ctx.permissions.includes("org:read")) throw new ForbiddenError();
}

function validDate(value: string | null | undefined, field: string): string | null {
  if (!value) return null;
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError(`${field} must be a valid date (YYYY-MM-DD)`);
  }
  return value;
}

async function validateAssignee(db: AppDb, orgId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
      ),
    )
    .limit(1);
  if (!row) throw new ValidationError("The assignee is not an active member of this organization");
  return userId;
}

export async function createTask(
  db: AppDb,
  ctx: OrgContext,
  input: TaskInput,
): Promise<{ id: string }> {
  assertWrite(ctx);
  const title = input.title.trim();
  if (title.length < 3) throw new ValidationError("Enter a task title");
  const priority = input.priority ?? "normal";
  if (!PRIORITIES.has(priority)) throw new ValidationError("Invalid priority");
  const dueDate = validDate(input.dueDate, "Due date");
  const periodStart = validDate(input.periodStart, "Period start");
  const periodEnd = validDate(input.periodEnd, "Period end");
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new ValidationError("Period start must be before period end");
  }
  if (input.customerId) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.orgId)))
      .limit(1);
    if (!customer) throw new ValidationError("Unknown customer");
  }
  const assigneeUserId = await validateAssignee(db, ctx.orgId, input.assigneeUserId);

  const [row] = await db
    .insert(tasks)
    .values({
      orgId: ctx.orgId,
      title: title.slice(0, 200),
      description: input.description?.trim().slice(0, 4000) || null,
      dueDate,
      priority,
      assigneeUserId,
      customerId: input.customerId || null,
      periodStart,
      periodEnd,
      createdBy: ctx.actor.user.id,
      source: "manual",
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("Could not create task");

  if (assigneeUserId && assigneeUserId !== ctx.actor.user.id) {
    await notifyUsers(db, {
      orgId: ctx.orgId,
      userIds: [assigneeUserId],
      category: "tasks",
      title: `Task assigned: ${title}`,
      body: dueDate ? `Due ${dueDate}.` : "No due date set.",
      href: `/app/tasks?task=${row.id}`,
      dedupeKey: `task-assigned:${row.id}`,
      email: () =>
        taskAssignedEmail({
          organizationName: ctx.orgName,
          title,
          dueDate,
          link: `${appUrl()}/app/tasks?task=${row.id}`,
        }),
    });
  }

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "task.created",
    entityType: "task",
    entityId: row.id,
    metadata: { priority, dueDate, assigneeUserId },
  });
  return row;
}

export async function updateTask(
  db: AppDb,
  ctx: OrgContext,
  taskId: string,
  input: TaskInput & { status?: "open" | "in_progress" | "done" | "cancelled" },
): Promise<void> {
  assertWrite(ctx);
  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId)))
    .limit(1);
  if (!existing) throw new NotFoundError("Task not found");

  const title = input.title.trim();
  if (title.length < 3) throw new ValidationError("Enter a task title");
  const priority = input.priority ?? existing.priority;
  if (!PRIORITIES.has(priority)) throw new ValidationError("Invalid priority");
  const assigneeUserId = await validateAssignee(db, ctx.orgId, input.assigneeUserId);
  const status = input.status ?? existing.status;
  const completedAt = status === "done" ? existing.completedAt ?? new Date() : null;
  const periodStart = validDate(input.periodStart, "Period start");
  const periodEnd = validDate(input.periodEnd, "Period end");
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new ValidationError("Period start must be before period end");
  }

  await db
    .update(tasks)
    .set({
      title: title.slice(0, 200),
      description: input.description?.trim().slice(0, 4000) || null,
      dueDate: validDate(input.dueDate, "Due date"),
      priority,
      assigneeUserId,
      customerId: input.customerId || null,
      periodStart,
      periodEnd,
      status,
      completedAt,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId)));

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "task.updated",
    entityType: "task",
    entityId: taskId,
    metadata: { status, priority, assigneeUserId },
  });
}

export async function completeTask(db: AppDb, ctx: OrgContext, taskId: string): Promise<void> {
  assertWrite(ctx);
  const [row] = await db
    .update(tasks)
    .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId)))
    .returning({ id: tasks.id });
  if (!row) throw new NotFoundError("Task not found");
  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "task.completed",
    entityType: "task",
    entityId: taskId,
  });
}

export type TaskFilters = {
  status?: "all" | "open" | "in_progress" | "done" | "cancelled" | "overdue";
  priority?: string;
  assignee?: string;
  q?: string;
};

export async function listTasks(db: AppDb, ctx: OrgContext, filters: TaskFilters = {}) {
  assertRead(ctx);
  const conditions = [eq(tasks.orgId, ctx.orgId)];
  const today = new Date().toISOString().slice(0, 10);
  if (filters.status === "overdue") {
    conditions.push(
      isNotNull(tasks.dueDate),
      lt(tasks.dueDate, today),
      inArray(tasks.status, ["open", "in_progress"]),
    );
  } else if (filters.status && filters.status !== "all") {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (filters.priority) conditions.push(eq(tasks.priority, filters.priority));
  if (filters.assignee === "me") conditions.push(eq(tasks.assigneeUserId, ctx.actor.user.id));
  else if (filters.assignee) conditions.push(eq(tasks.assigneeUserId, filters.assignee));
  if (filters.q) conditions.push(ilike(tasks.title, `%${filters.q}%`));

  const rows = await db
    .select({
      task: tasks,
      assigneeName: users.name,
      assigneeEmail: users.email,
      customerName: customers.name,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeUserId))
    .leftJoin(customers, eq(customers.id, tasks.customerId))
    .where(and(...conditions))
    .orderBy(asc(tasks.dueDate), asc(tasks.createdAt))
    .limit(300);

  return rows.map((row) => ({
    ...row.task,
    assigneeName: row.assigneeName,
    assigneeEmail: row.assigneeEmail,
    customerName: row.customerName,
    overdue:
      Boolean(row.task.dueDate) &&
      (row.task.dueDate as string) < today &&
      (row.task.status === "open" || row.task.status === "in_progress"),
  }));
}

export async function taskSummary(db: AppDb, ctx: OrgContext) {
  assertRead(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${tasks.status} in ('open','in_progress'))::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today} and ${tasks.status} in ('open','in_progress'))::int`,
      dueToday: sql<number>`count(*) filter (where ${tasks.dueDate} = ${today} and ${tasks.status} in ('open','in_progress'))::int`,
    })
    .from(tasks)
    .where(eq(tasks.orgId, ctx.orgId));
  return { open: Number(row?.open ?? 0), overdue: Number(row?.overdue ?? 0), dueToday: Number(row?.dueToday ?? 0) };
}

export async function listAssignableUsers(db: AppDb, orgId: string) {
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")))
    .orderBy(users.name);
}

export async function activeMemberIds(db: AppDb, orgId: string): Promise<string[]> {
  return orgMemberIds(db, orgId);
}
