import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { getReconciliationJob } from "@/lib/reconciliation";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { reviewFindingAction } from "../../actions";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Reconciliation job" };
export const dynamic = "force-dynamic";

export default async function ReconciliationJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { org } = await requirePageContext("recon:read");
  const canReview = org.permissions.includes("recon:review");
  let data: Awaited<ReturnType<typeof getReconciliationJob>>;
  try {
    data = await getReconciliationJob(getDb(), org, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { job, findings } = data;
  const open = findings.filter((finding) => finding.status === "open").length;
  const currency = job.mapping ? "RWF" : "RWF";

  return (
    <>
      <PageHeader
        eyebrow={org.orgName}
        title={job.filename}
        description={`${job.source === "ebm_sales" ? "Sales report" : "Purchases report"} · ${job.rowsTotal} rows · created ${formatDateTime(job.createdAt)}`}
        actions={<Link className="btn secondary" href="/app/reconciliation">All jobs</Link>}
      />
      {query.ok ? <Alert tone="success">{query.ok}</Alert> : null}
      {query.error ? <Alert tone="error">{query.error}</Alert> : null}
      <div className="grid grid-4 section">
        <div className="card stat green"><div className="label">Matched rows</div><div className="value">{job.rowsMatched}</div></div>
        <div className="card stat red"><div className="label">Findings</div><div className="value">{job.findingsCount}</div><div className="note">{open} open</div></div>
        <div className="card stat"><div className="label">Rows imported</div><div className="value">{job.rowsTotal}</div></div>
        <div className="card stat blue"><div className="label">Status</div><div className="value" style={{ fontSize: "1.1rem", marginTop: "0.5rem" }}><Badge value={job.status} /></div></div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Findings</h2><span className="small muted">Human review required</span></div>
        {findings.length === 0 ? (
          <EmptyState title="No differences found">Every row matched an existing record by reference and amount.</EmptyState>
        ) : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Row</th><th>Finding</th><th>Reference</th><th className="right">Expected</th><th className="right">Reported</th><th>Review</th></tr></thead>
            <tbody>{findings.map((finding) => (
              <tr key={finding.id}>
                <td className="small">{finding.rowNumber ?? "-"}</td>
                <td><Badge value={finding.severity} /><div className="small">{finding.message}</div><div className="tiny muted mono">{finding.code}</div></td>
                <td className="mono small">{finding.invoiceNumber ?? "-"}</td>
                <td className="right mono small">{finding.expectedCents != null ? formatMoney(finding.expectedCents, currency) : "-"}</td>
                <td className="right mono small">{finding.actualCents != null ? formatMoney(finding.actualCents, currency) : "-"}</td>
                <td>
                  {finding.status !== "open" ? (
                    <div><Badge value={finding.status} />{finding.resolutionNote ? <div className="tiny muted">{finding.resolutionNote}</div> : null}</div>
                  ) : canReview ? (
                    <form action={reviewFindingAction} className="stack-tight">
                      <input type="hidden" name="jobId" value={job.id} />
                      <input type="hidden" name="findingId" value={finding.id} />
                      <select name="status" defaultValue="accepted" style={{ width: 150, padding: "0.25rem" }}>
                        <option value="accepted">Accept difference</option>
                        <option value="resolved">Mark resolved</option>
                        <option value="dismissed">Dismiss</option>
                      </select>
                      <input name="note" placeholder="Resolution note" style={{ width: 150, padding: "0.25rem" }} />
                      <button className="btn small secondary" type="submit">Save review</button>
                    </form>
                  ) : <span className="tiny muted">Awaiting reviewer</span>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
