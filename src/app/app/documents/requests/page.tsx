import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listDocumentRequests, listDocuments } from "@/lib/documents";
import { formatDate } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { createDocumentRequestAction, fulfilDocumentRequestAction } from "../../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Document requests" };
export const dynamic = "force-dynamic";

export default async function DocumentRequestsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("documents:read");
  try {
    const [requests, documents] = await Promise.all([
      listDocumentRequests(getDb(), org.orgId),
      listDocuments(getDb(), org.orgId),
    ]);
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Document requests" description="Ask the business for missing records and link the file that fulfils each request." actions={<Link className="btn secondary" href="/app/documents">Document room</Link>} />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="card section">
          <div className="card-head"><h2>New request</h2></div>
          <form action={createDocumentRequestAction} className="card-pad">
            <input type="hidden" name="returnTo" value="/app/documents/requests" />
            <div className="form-grid">
              <div className="field"><label htmlFor="title">What is needed?</label><input id="title" name="title" required minLength={3} placeholder="March bank statement" /></div>
              <div className="field"><label htmlFor="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" /></div>
              <div className="field"><label htmlFor="periodStart">Period start</label><input id="periodStart" name="periodStart" type="date" /></div>
              <div className="field"><label htmlFor="periodEnd">Period end</label><input id="periodEnd" name="periodEnd" type="date" /></div>
            </div>
            <div className="field"><label htmlFor="description">Details</label><textarea id="description" name="description" /></div>
            <button className="btn accent" type="submit">Create request</button>
          </form>
        </div>
        <div className="card">
          <div className="card-head"><h2>Open requests</h2><span className="small muted">{requests.length}</span></div>
          {requests.length === 0 ? <EmptyState title="No requests">Create a request when a client needs to supply missing records.</EmptyState> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Request</th><th>Period</th><th>Due</th><th>Status</th><th>Fulfil with</th></tr></thead>
              <tbody>{requests.map((request) => (
                <tr key={request.id}>
                  <td><div className="strong">{request.title}</div>{request.description ? <div className="tiny muted">{request.description}</div> : null}</td>
                  <td className="small">{request.periodStart ? `${formatDate(request.periodStart)} – ${formatDate(request.periodEnd)}` : "-"}</td>
                  <td className="small">{formatDate(request.dueDate)}</td>
                  <td><Badge value={request.status} /></td>
                  <td>{request.status === "open" ? (
                    <form action={fulfilDocumentRequestAction} className="row" style={{ gap: "0.3rem" }}>
                      <input type="hidden" name="returnTo" value="/app/documents/requests" />
                      <input type="hidden" name="requestId" value={request.id} />
                      <select name="documentId" required defaultValue="" style={{ width: 170 }}><option value="" disabled>Select file</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.originalFilename}</option>)}</select>
                      <button className="btn small secondary" type="submit">Link</button>
                    </form>
                  ) : "-"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "document requests");
  }
}
