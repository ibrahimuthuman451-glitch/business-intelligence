import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listReconciliationJobs } from "@/lib/reconciliation";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { ReconciliationImport } from "@/components/reconciliation-import";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Reconciliation" };
export const dynamic = "force-dynamic";

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("recon:read");
  const canWrite = org.permissions.includes("recon:write");
  try {
    const jobs = await listReconciliationJobs(getDb(), org);
    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Reconciliation"
          description="Compare imported sales or purchase reports against your own records. Findings are traceable and require human review."
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="alert warn">
          <strong>File-based only.</strong> There is no live EBM/RRA integration. Nothing here is an official tax
          filing, and we never collect government portal credentials.
        </div>
        {canWrite ? <ReconciliationImport /> : null}
        <div className="card">
          <div className="card-head"><h2>Reconciliation jobs</h2><span className="small muted">{jobs.length}</span></div>
          {jobs.length === 0 ? (
            <EmptyState title="No reconciliations yet">Export a sales or purchases report and import it above.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>File</th><th>Type</th><th>Rows</th><th>Matched</th><th>Findings</th><th>Status</th><th>Run</th></tr></thead>
              <tbody>{jobs.map((job) => (
                <tr key={job.id}>
                  <td><Link href={`/app/reconciliation/${job.id}`} className="strong">{job.filename}</Link><div className="tiny muted">{job.format.toUpperCase()}</div></td>
                  <td className="small">{job.source === "ebm_sales" ? "Sales report" : "Purchases report"}</td>
                  <td className="small">{job.rowsTotal}</td>
                  <td className="small">{job.rowsMatched}</td>
                  <td className="small">{job.findingsCount}</td>
                  <td><Badge value={job.status} />{job.error ? <div className="tiny" style={{ color: "var(--red)" }}>{job.error}</div> : null}</td>
                  <td className="small nowrap">{formatDateTime(job.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "reconciliation");
  }
}
