import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { requirePageContext } from "@/lib/current-user";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("audit:read");
  try {
    const rows = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.orgId, org.orgId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(200);
    const filtered = params.action ? rows.filter((row) => row.action.includes(params.action!)) : rows;
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Audit log" description="Security-relevant events for this organization. Entries are append-only from the application's perspective." />
        <form method="get" className="card card-pad section inline-form">
          <div className="field grow"><label htmlFor="action">Filter by action</label><input id="action" name="action" defaultValue={params.action ?? ""} placeholder="e.g. document, invitation, payment" /></div>
          <button className="btn secondary" type="submit">Filter</button>
        </form>
        <div className="card">
          <div className="card-head"><h2>Events</h2><span className="small muted">{filtered.length} shown</span></div>
          {filtered.length === 0 ? <div className="empty">No audit events yet.</div> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Entity</th><th>Details</th></tr></thead>
              <tbody>{filtered.map((event) => (
                <tr key={event.id}>
                  <td className="small nowrap">{formatDateTime(event.createdAt)}</td>
                  <td><span className="mono small">{event.action}</span></td>
                  <td className="small">{event.actorEmail ?? "system"}</td>
                  <td className="small">{event.entityType ?? "-"}<div className="tiny muted mono">{event.entityId?.slice(0, 12) ?? ""}</div></td>
                  <td className="tiny">{event.metadata ? <code>{JSON.stringify(event.metadata)}</code> : "-"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "audit log");
  }
}
