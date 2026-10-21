import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { tasks } from "@/db/schema";
import { requirePageContext } from "@/lib/current-user";
import { listAssignableUsers } from "@/lib/tasks";
import { listContacts } from "@/lib/finance-service";
import { Alert, PageHeader } from "@/components/ui";
import { updateTaskAction } from "../../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Edit task" };
export const dynamic = "force-dynamic";

export default async function EditTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { org } = await requirePageContext("org:read");
  try {
    const db = getDb();
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.orgId, org.orgId)))
      .limit(1);
    if (!task) notFound();
    const [members, contacts] = await Promise.all([
      listAssignableUsers(db, org.orgId),
      listContacts(db, org),
    ]);
    const canWrite = org.permissions.includes("finance:write");

    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Edit task" description={task.title} actions={<Link className="btn secondary" href="/app/tasks">Back</Link>} />
        {query.ok ? <Alert tone="success">{query.ok}</Alert> : null}
        {query.error ? <Alert tone="error">{query.error}</Alert> : null}
        <div className="card card-pad">
          <form action={updateTaskAction}>
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="returnTo" value={`/app/tasks/${task.id}`} />
            <div className="form-grid">
              <div className="field"><label htmlFor="title">Title</label><input id="title" name="title" defaultValue={task.title} required disabled={!canWrite} /></div>
              <div className="field"><label htmlFor="assignee">Assignee</label><select id="assignee" name="assigneeUserId" defaultValue={task.assigneeUserId ?? ""} disabled={!canWrite}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></div>
              <div className="field"><label htmlFor="priority">Priority</label><select id="priority" name="priority" defaultValue={task.priority} disabled={!canWrite}>{["low", "normal", "high", "urgent"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
              <div className="field"><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={task.status} disabled={!canWrite}>{["open", "in_progress", "done", "cancelled"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></div>
              <div className="field"><label htmlFor="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" defaultValue={task.dueDate ?? ""} disabled={!canWrite} /></div>
              <div className="field"><label htmlFor="customer">Client</label><select id="customer" name="customerId" defaultValue={task.customerId ?? ""} disabled={!canWrite}><option value="">No client</option>{contacts.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></div>
              <div className="field"><label htmlFor="periodStart">Period start</label><input id="periodStart" name="periodStart" type="date" defaultValue={task.periodStart ?? ""} disabled={!canWrite} /></div>
              <div className="field"><label htmlFor="periodEnd">Period end</label><input id="periodEnd" name="periodEnd" type="date" defaultValue={task.periodEnd ?? ""} disabled={!canWrite} /></div>
            </div>
            <div className="field"><label htmlFor="description">Details</label><textarea id="description" name="description" defaultValue={task.description ?? ""} disabled={!canWrite} /></div>
            {canWrite ? <button className="btn accent" type="submit">Save task</button> : <p className="small muted mb-0">Your role can view but not edit tasks.</p>}
          </form>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "task");
  }
}
