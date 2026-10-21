import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listTenders } from "@/lib/tenders";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { serviceUnavailable } from "@/lib/page-guards";
import { saveTenderAction } from "../actions";

export const metadata: Metadata = { title: "Tender intelligence" };
export const dynamic = "force-dynamic";

export default async function TendersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; q?: string; category?: string; status?: string; saved?: string }>;
}) {
  const params = await searchParams;
  const { org } = await requirePageContext("tenders:read");
  const status = params.status === "closed" ? "closed" : params.status === "all" ? "all" : "open";
  try {
    const tenders = await listTenders(getDb(), org, {
      q: params.q,
      category: params.category,
      status,
      saved: params.saved === "1",
    });
    const canWrite = org.permissions.includes("tenders:write");
    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Tender intelligence"
          description="Verified notices with source links, provenance and deadlines. Relevance is not eligibility; always check the official notice."
          actions={canWrite ? <Link className="btn accent" href="/app/tenders/import">Import verified notice</Link> : null}
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}

        <div className="alert warn">
          <strong>No live feed is connected.</strong> Notices are imported manually from an official source
          by your team. Rows marked <span className="badge amber">sample</span> are demonstration data,
          not real tenders. Deadlines shown are only as reliable as the source URL and verification time.
        </div>

        <div className="pill-tabs">
          <Link href="/app/tenders" className={!params.saved ? "active" : undefined}>All opportunities</Link>
          <Link href="/app/tenders?saved=1&status=all" className={params.saved ? "active" : undefined}>Saved</Link>
        </div>

        <form method="get" className="card card-pad section inline-form">
          <div className="field grow"><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={params.q ?? ""} placeholder="Title, reference or buyer" /></div>
          <div className="field"><label htmlFor="category">Category</label><input id="category" name="category" defaultValue={params.category ?? ""} placeholder="e.g. construction" /></div>
          <div className="field"><label htmlFor="status">Deadline</label><select id="status" name="status" defaultValue={status}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select></div>
          <button className="btn secondary" type="submit">Filter</button>
        </form>

        <div className="card">
          <div className="card-head"><h2>Opportunities</h2><span className="small muted">{tenders.length} shown</span></div>
          {tenders.length === 0 ? (
            <EmptyState title="No notices match" action={canWrite ? <Link className="btn small" href="/app/tenders/import">Import one</Link> : undefined}>
              Import a notice from an official procurement source to begin.
            </EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Tender</th><th>Buyer / region</th><th>Closes</th><th>Budget</th><th>Relevance</th><th>Saved</th><th>Provenance</th></tr></thead>
              <tbody>{tenders.map((tender) => (
                <tr key={tender.id}>
                  <td><Link href={`/app/tenders/${tender.id}`} className="strong">{tender.title}</Link><div className="tiny muted mono">{tender.reference}</div></td>
                  <td className="small">{tender.buyer ?? "-"}<div className="tiny muted">{tender.region ?? "-"} · {tender.category ?? "uncategorised"}</div></td>
                  <td className="nowrap small">{formatDate(tender.closesAt)}<div className={tender.daysLeft <= 7 && !tender.closed ? "tiny" : "tiny muted"} style={tender.daysLeft <= 7 && !tender.closed ? { color: "var(--red)" } : undefined}>{tender.closed ? "closed" : `${tender.daysLeft} days left`}</div></td>
                  <td className="small nowrap">{tender.budgetCents != null ? formatMoney(tender.budgetCents, tender.currency) : "-"}</td>
                  <td>{tender.matchScore != null ? <div><strong>{tender.matchScore}</strong><span className="tiny muted">/100</span></div> : <span className="tiny muted">not assessed</span>}</td>
                  <td>{canWrite ? (
                    <form action={saveTenderAction}>
                      <input type="hidden" name="returnTo" value="/app/tenders" />
                      <input type="hidden" name="tenderId" value={tender.id} />
                      <input type="hidden" name="saved" value={tender.saved ? "false" : "true"} />
                      <button className="btn small secondary" type="submit">{tender.saved ? "Unsave" : "Save"}</button>
                    </form>
                  ) : tender.saved ? "Saved" : "-"}</td>
                  <td><Badge value={tender.provenance} />{tender.verifiedAt ? <div className="tiny muted">verified {formatDateTime(tender.verifiedAt)}</div> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "tenders");
  }
}
