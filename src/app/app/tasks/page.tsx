import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listAssignableUsers, listTasks, taskSummary } from "@/lib/tasks";
import { listContacts } from "@/lib/finance-service";
import { formatDate } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { completeTaskAction, createTaskAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Tasks" };
export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; status?: string; assignee?: string; q?: string }>;
}) {
  const params = await searchParams;
  const { org } = await requirePageContext("org:read");
  const canWrite = org.permissions.includes("finance:write");
  const status = (params.status ?? "open") as "all" | "open" | "in_progress" | "done" | "overdue";
  try {
    const db = getDb();
    const [tasks, summary, members, contacts] = await Promise.all([
      listTasks(db, org, { status, assignee: params.assignee, q: params.q }),
      taskSummary(db, org),
      listAssignableUsers(db, org.orgId),
      listContacts(db, org),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Tasks & deadlines"
          description="Work items linked to clients and reporting periods. Reminders are generated from persisted state by the scheduled job, not an in-process timer."
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}

        <div className="grid grid-3 section">
          <div className="card stat"><div className="label">Open</div><div className="value">{summary.open}</div></div>
          <div className="card stat accent"><div className="label">Due today</div><div className="value">{summary.dueToday}</div></div>
          <div className="card stat red"><div className="label">Overdue</div><div className="value">{summary.overdue}</div></div>
        </div>

        {canWrite ? (
          <details className="card section card-pad">
            <summary className="strong" style={{ cursor: "pointer" }}>Create a task</summary>
            <form action={createTaskAction} className="mt-2">
              <input type="hidden" name="returnTo" value="/app/tasks" />
              <div className="form-grid">
                <div className="field"><label htmlFor="title">Title</label><input id="title" name="title" required minLength={3} /></div>
                <div className="field"><label htmlFor="assignee">Assignee</label><select id="assignee" name="assigneeUserId" defaultValue=""><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name} ({member.role})</option>)}</select></div>
                <div className="field"><label htmlFor="priority">Priority</label><select id="priority" name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
                <div className="field"><label htmlFor="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" /></div>
                <div className="field"><label htmlFor="customer">Client (optional)</label><select id="customer" name="customerId" defaultValue=""><option value="">No client</option>{contacts.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></div>
                <div className="field"><label htmlFor="periodStart">Period start</label><input id="periodStart" name="periodStart" type="date" /></div>
                <div className="field"><label htmlFor="periodEnd">Period end</label><input id="periodEnd" name="periodEnd" type="date" /></div>
              </div>
              <div className="field"><label htmlFor="description">Details</label><textarea id="description" name="description" /></div>
              <button className="btn accent" type="submit">Create task</button>
            </form>
          </details>
        ) : null}

        <div className="pill-tabs">
          {(["open", "in_progress", "overdue", "done", "all"] as const).map((value) => (
            <Link key={value} href={`/app/tasks?status=${value}`} className={status === value ? "active" : undefined}>
              {value.replace("_", " ")}
            </Link>
          ))}
          <Link href="/app/tasks?status=open&assignee=me" className={params.assignee === "me" ? "active" : undefined}>Assigned to me</Link>
        </div>

        <form method="get" className="card card-pad section inline-form">
          <input type="hidden" name="status" value={status} />
          <div className="field grow"><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={params.q ?? ""} placeholder="Task title" /></div>
          <button className="btn secondary" type="submit">Filter</button>
        </form>

        <div className="card">
          <div className="card-head"><h2>Tasks</h2><span className="small muted">{tasks.length}</span></div>
          {tasks.length === 0 ? (
            <EmptyState title="No tasks in this view">Create a task or switch the filter.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Task</th><th>Client / period</th><th>Assignee</th><th>Due</th><th>Priority</th><th>Status</th><th></th></tr></thead>
              <tbody>{tasks.map((task) => (
                <tr key={task.id}>
                  <td><Link href={`/app/tasks/${task.id}`} className="strong">{task.title}</Link>{task.description ? <div className="tiny muted">{task.description}</div> : null}</td>
                  <td className="small">{task.customerName ?? "-"}{task.periodStart ? <div className="tiny muted">{formatDate(task.periodStart)} – {formatDate(task.periodEnd)}</div> : null}</td>
                  <td className="small">{task.assigneeName ?? "Unassigned"}</td>
                  <td className="small nowrap">{formatDate(task.dueDate)}{task.overdue ? <div className="tiny" style={{ color: "var(--red)" }}>overdue</div> : task.dueDate === today ? <div className="tiny" style={{ color: "var(--amber)" }}>today</div> : null}</td>
                  <td><Badge value={task.priority === "urgent" ? "red" : task.priority === "high" ? "amber" : "gray"} label={task.priority} /></td>
                  <td><Badge value={task.status} /></td>
                  <td>{canWrite && task.status !== "done" && task.status !== "cancelled" ? (
                    <form action={completeTaskAction}><input type="hidden" name="returnTo" value="/app/tasks" /><input type="hidden" name="taskId" value={task.id} /><button className="btn small secondary" type="submit">Complete</button></form>
                  ) : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "tasks");
  }
}
