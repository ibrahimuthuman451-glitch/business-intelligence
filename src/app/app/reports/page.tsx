import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { entitlementSnapshot } from "@/lib/entitlements";
import { bytes } from "@/lib/format";
import { Alert, Badge, PageHeader } from "@/components/ui";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Reports & exports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  try {
    const snapshot = await entitlementSnapshot(getDb(), org.orgId);
    const exportsEnabled = snapshot.limits.advancedExports;
    const reports = [
      { type: "sales", label: "Sales ledger", detail: "Net, tax and gross by recorded sale." },
      { type: "invoices", label: "Invoice register", detail: "Totals, payments and outstanding balances." },
      { type: "tasks", label: "Task register", detail: "Assignments, due dates and client periods." },
    ];

    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Reports & exports"
          description="CSV exports are generated from the authorized organization's records only. Demo data remains labelled."
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        {snapshot.plan === "demo" ? (
          <Alert tone="warn">This demo workspace exports fictional sample records. Do not treat them as statutory filings.</Alert>
        ) : null}
        {!exportsEnabled ? (
          <Alert tone="info">Advanced exports are not included in the <strong>{snapshot.plan}</strong> plan. Ask the owner to upgrade.</Alert>
        ) : null}
        <div className="grid grid-3 section">
          {reports.map((report) => (
            <div className="card card-pad" key={report.type}>
              <h2 style={{ fontSize: "1.05rem" }}>{report.label}</h2>
              <p className="small muted">{report.detail}</p>
              {exportsEnabled ? (
                <a className="btn secondary" href={`/api/reports/${report.type}`}>Download CSV</a>
              ) : (
                <button className="btn secondary" type="button" disabled>Upgrade required</button>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head"><h2>Plan & usage</h2><Badge value={snapshot.plan} /></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Limit</th><th>Used</th><th>Included</th></tr></thead>
            <tbody>
              <tr><td>Team members</td><td>{snapshot.usage.teamMembers} (+{snapshot.usage.pendingInvitations} pending)</td><td>{snapshot.limits.teamMembers}</td></tr>
              <tr><td>Documents</td><td>{snapshot.usage.documents}</td><td>{snapshot.limits.documentsCount}</td></tr>
              <tr><td>Document storage</td><td>{bytes(snapshot.usage.storageBytes)}</td><td>{bytes(snapshot.limits.documentStorageBytes)}</td></tr>
              <tr><td>Saved opportunities</td><td>{snapshot.usage.savedTenders}</td><td>{snapshot.limits.savedTenders}</td></tr>
              <tr><td>Advisor clients</td><td>{snapshot.usage.advisorClients}</td><td>{snapshot.limits.advisorClients}</td></tr>
              <tr><td>Advanced exports</td><td>{exportsEnabled ? "Enabled" : "Not included"}</td><td>{snapshot.limits.advancedExports ? "Yes" : "No"}</td></tr>
              <tr><td>AI credits</td><td>No AI feature enabled</td><td>{snapshot.limits.aiCredits}</td></tr>
            </tbody>
          </table></div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "reports");
  }
}
