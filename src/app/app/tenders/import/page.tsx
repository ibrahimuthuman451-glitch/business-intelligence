import Link from "next/link";
import type { Metadata } from "next";
import { requirePageContext } from "@/lib/current-user";
import { Alert, PageHeader } from "@/components/ui";
import { importTenderAction } from "../../actions";

export const metadata: Metadata = { title: "Import tender" };
export const dynamic = "force-dynamic";

export default async function ImportTenderPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("tenders:write");
  return (
    <>
      <PageHeader eyebrow={org.orgName} title="Import a verified notice" description="Transcribe only what the official notice says. Never estimate a deadline or reference." actions={<Link className="btn secondary" href="/app/tenders">Back</Link>} />
      {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      <div className="alert info">
        Open the official procurement page first. Copy the reference, buyer, closing date and URL exactly.
        The import records who entered it and when it was verified. Do not upload government portal passwords.
      </div>
      <div className="card card-pad">
        <form action={importTenderAction}>
          <input type="hidden" name="returnTo" value="/app/tenders" />
          <div className="form-grid">
            <div className="field"><label htmlFor="reference">Official reference</label><input id="reference" name="reference" required placeholder="e.g. 000045/G/NCB/2026" /></div>
            <div className="field"><label htmlFor="title">Title</label><input id="title" name="title" required minLength={4} /></div>
            <div className="field"><label htmlFor="buyer">Buyer</label><input id="buyer" name="buyer" /></div>
            <div className="field"><label htmlFor="category">Category</label><input id="category" name="category" placeholder="construction, IT, consultancy" /></div>
            <div className="field"><label htmlFor="region">Region</label><input id="region" name="region" placeholder="Kigali" /></div>
            <div className="field"><label htmlFor="budget">Budget (if published)</label><input id="budget" name="budget" inputMode="decimal" placeholder="Leave blank if not stated" /></div>
            <div className="field"><label htmlFor="publishedAt">Published date</label><input id="publishedAt" name="publishedAt" type="date" /></div>
            <div className="field"><label htmlFor="closesAt">Closing date and time</label><input id="closesAt" name="closesAt" type="datetime-local" required /></div>
            <div className="field"><label htmlFor="sourceName">Source name</label><input id="sourceName" name="sourceName" placeholder="Official procurement portal" /></div>
            <div className="field"><label htmlFor="sourceUrl">Source URL</label><input id="sourceUrl" name="sourceUrl" type="url" required placeholder="https://..." /></div>
          </div>
          <div className="field"><label htmlFor="description">Description / requirements summary</label><textarea id="description" name="description" placeholder="Summarise only what the notice states" /></div>
          <button className="btn accent" type="submit">Record verified import</button>
        </form>
      </div>
    </>
  );
}
