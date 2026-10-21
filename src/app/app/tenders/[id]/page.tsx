import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { getTender } from "@/lib/tenders";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { Alert, Badge, PageHeader } from "@/components/ui";
import { assessTenderAction, createChecklistAction, saveTenderAction, toggleChecklistItemAction } from "../../actions";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Tender" };
export const dynamic = "force-dynamic";

export default async function TenderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { org } = await requirePageContext("tenders:read");
  const canWrite = org.permissions.includes("tenders:write");
  let tender: Awaited<ReturnType<typeof getTender>>;
  try {
    tender = await getTender(getDb(), org, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const isSample = tender.provenance === "sample";
  const checklist = tender.checklist;
  const required = checklist?.items.filter((item) => item.required) ?? [];
  const done = required.filter((item) => item.done).length;
  const readiness = required.length === 0 ? 0 : Math.round((done / required.length) * 100);

  return (
    <>
      <PageHeader
        eyebrow={org.orgName}
        title={tender.title}
        description={<>{tender.buyer ?? "Buyer not recorded"} · ref <span className="mono">{tender.reference}</span></>}
        actions={<>
          <Link className="btn secondary" href="/app/tenders">All tenders</Link>
          {canWrite ? (
            <form action={saveTenderAction}>
              <input type="hidden" name="returnTo" value={`/app/tenders/${tender.id}`} />
              <input type="hidden" name="tenderId" value={tender.id} />
              <input type="hidden" name="saved" value={tender.match?.saved ? "false" : "true"} />
              <button className="btn" type="submit">{tender.match?.saved ? "Remove from saved" : "Save opportunity"}</button>
            </form>
          ) : null}
        </>}
      />
      {query.ok ? <Alert tone="success">{query.ok}</Alert> : null}
      {query.error ? <Alert tone="error">{query.error}</Alert> : null}
      {isSample ? (
        <Alert tone="warn"><strong>Sample data.</strong> This is not a real procurement notice and must not be bid on. Import a verified notice from an official source.</Alert>
      ) : null}

      <div className="grid grid-2 section">
        <div className="card card-pad">
          <h2>Notice details</h2>
          <dl className="kv">
            <dt>Category</dt><dd>{tender.category ?? "Not recorded"}</dd>
            <dt>Region</dt><dd>{tender.region ?? "Not recorded"}</dd>
            <dt>Budget</dt><dd>{tender.budgetCents != null ? formatMoney(tender.budgetCents, tender.currency) : "Not published"}</dd>
            <dt>Published</dt><dd>{formatDate(tender.publishedAt)}</dd>
            <dt>Closes</dt><dd><strong>{formatDateTime(tender.closesAt)}</strong> {tender.closed ? <Badge value="closed" label="closed" /> : <span className="small">({tender.daysLeft} days left)</span>}</dd>
            <dt>Provenance</dt><dd><Badge value={tender.provenance} /></dd>
            <dt>Verified</dt><dd>{formatDateTime(tender.verifiedAt)}</dd>
            <dt>Source</dt><dd><a href={tender.sourceUrl} target="_blank" rel="noopener noreferrer">Open official notice</a><div className="tiny muted">{tender.sourceName ?? new URL(tender.sourceUrl).hostname}{tender.sourceMethod ? ` · ${tender.sourceMethod.replace("_", " ")}` : ""}</div></dd>
          </dl>
          {tender.description ? <p className="quote mt-2">{tender.description}</p> : null}
        </div>

        <div className="card card-pad">
          <div className="row-between"><h2>Relevance assessment</h2>{tender.match ? <span className="badge blue">{tender.match.relevanceScore}/100</span> : null}</div>
          <p className="small muted">Relevance compares the notice text with your sector, city and keywords. Eligibility requires checking mandatory requirements in the official notice.</p>
          {tender.match ? (
            <ul className="list">
              {tender.match.reasons.map((reason) => <li key={reason} className="small">{reason}</li>)}
            </ul>
          ) : <p className="small">Not assessed yet.</p>}
          <div className="row mt-1">
            <form action={assessTenderAction}>
              <input type="hidden" name="tenderId" value={tender.id} />
              <button className="btn secondary" type="submit">Re-assess fit</button>
            </form>
            <div><span className="tiny muted">Preliminary eligibility</span><div><Badge value={tender.match?.eligibility ?? "unknown"} label={tender.match?.eligibility === "unknown" ? "not determined" : undefined} /></div></div>
          </div>
        </div>
      </div>

      <div className="card section">
        <div className="card-head">
          <h2>Bid-readiness checklist</h2>
          {checklist ? <span className="small muted">{done}/{required.length} required items · {readiness}%</span> : null}
        </div>
        <div className="card-pad">
          {!checklist ? (
            <div className="row-between">
              <p className="small muted mb-0">Create a checklist to track the documents this bid requires.</p>
              {canWrite ? (
                <form action={createChecklistAction}>
                  <input type="hidden" name="tenderId" value={tender.id} />
                  <button className="btn" type="submit">Create checklist</button>
                </form>
              ) : null}
            </div>
          ) : (
            <>
              <div className="bar mb-2"><span style={{ width: `${readiness}%` }} /></div>
              <ul className="checklist">
                {checklist.items.map((item) => (
                  <li key={item.id} className={item.done ? "done" : undefined}>
                    {canWrite ? (
                      <form action={toggleChecklistItemAction}>
                        <input type="hidden" name="tenderId" value={tender.id} />
                        <input type="hidden" name="itemId" value={item.id} />
                        <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                        <button className="btn-link" type="submit" aria-label={item.done ? "Mark not done" : "Mark done"}>{item.done ? "[x]" : "[ ]"}</button>
                      </form>
                    ) : <span>{item.done ? "[x]" : "[ ]"}</span>}
                    <label>{item.label}{item.required ? <span className="tiny muted"> required</span> : null}</label>
                  </li>
                ))}
              </ul>
              <p className="tiny muted mt-2 mb-0">Checklist items are generic preparation steps. Confirm the actual mandatory documents in the official notice before submitting.</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
