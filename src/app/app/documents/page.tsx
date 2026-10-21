import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listDocuments } from "@/lib/documents";
import { formatDate, formatDateTime, bytes } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { deleteDocumentAction, reviewDocumentAction, uploadDocumentAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";
import { maxUploadBytes } from "@/lib/storage";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; status?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("documents:read");
  const canWrite = org.permissions.includes("documents:write");
  const canReview = org.permissions.includes("documents:review");
  try {
    const documents = await listDocuments(getDb(), org.orgId, { status: params.status });
    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Document room"
          description="Files are stored outside the web root and served only after a server-side permission check. Every download is audited."
          actions={<Link className="btn secondary" href="/app/documents/requests">Document requests</Link>}
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="pill-tabs">
          <Link href="/app/documents" className={!params.status ? "active" : undefined}>All</Link>
          <Link href="/app/documents?status=uploaded" className={params.status === "uploaded" ? "active" : undefined}>Uploaded</Link>
          <Link href="/app/documents?status=in_review" className={params.status === "in_review" ? "active" : undefined}>In review</Link>
          <Link href="/app/documents?status=approved" className={params.status === "approved" ? "active" : undefined}>Approved</Link>
          <Link href="/app/documents?status=rejected" className={params.status === "rejected" ? "active" : undefined}>Rejected</Link>
        </div>

        {canWrite ? (
          <div className="card section">
            <div className="card-head"><h2>Upload a document</h2><span className="tiny muted">PDF, PNG, JPEG, CSV, XLSX or TXT · max {Math.floor(maxUploadBytes() / 1048576)} MB</span></div>
            <form action={uploadDocumentAction} encType="multipart/form-data" className="card-pad">
              <input type="hidden" name="returnTo" value="/app/documents" />
              <div className="form-grid">
                <div className="field"><label htmlFor="file">File</label><input id="file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.txt" /></div>
                <div className="field"><label htmlFor="category">Category</label><select id="category" name="category" defaultValue="general"><option value="general">General</option><option value="sales">Sales</option><option value="purchases">Purchases</option><option value="payroll">Payroll</option><option value="tax">Tax</option><option value="bank">Bank</option><option value="contract">Contract</option></select></div>
                <div className="field"><label htmlFor="periodStart">Reporting period start</label><input id="periodStart" name="periodStart" type="date" /></div>
                <div className="field"><label htmlFor="periodEnd">Reporting period end</label><input id="periodEnd" name="periodEnd" type="date" /></div>
              </div>
              <button className="btn accent" type="submit">Upload privately</button>
            </form>
          </div>
        ) : null}

        <div className="card">
          <div className="card-head"><h2>Files</h2><span className="small muted">{documents.length}</span></div>
          {documents.length === 0 ? (
            <EmptyState title="No documents yet">Upload bank statements, receipts or tax filings to build the reporting file.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>File</th><th>Category</th><th>Period</th><th>Review</th><th>Scan</th><th>Uploaded</th><th></th></tr></thead>
              <tbody>{documents.map((document) => (
                <tr key={document.id}>
                  <td><a href={`/api/documents/${document.id}/download`} className="strong">{document.originalFilename}</a><div className="tiny muted">{bytes(document.sizeBytes)} · {document.mimeType}</div></td>
                  <td><span className="badge gray">{document.category}</span></td>
                  <td className="small nowrap">{document.periodStart ? `${formatDate(document.periodStart)} – ${formatDate(document.periodEnd)}` : "-"}</td>
                  <td><Badge value={document.status} />{document.reviewNotes ? <div className="tiny muted">{document.reviewNotes}</div> : null}</td>
                  <td><Badge value={document.scanStatus === "clean" ? "green" : document.scanStatus === "infected" ? "red" : "gray"} label={document.scanStatus.replace("_", " ")} />{document.scanStatus === "not_scanned" ? <div className="tiny muted">scanner not configured</div> : null}</td>
                  <td className="small nowrap">{formatDateTime(document.createdAt)}</td>
                  <td>
                    <div className="stack-tight">
                      {canReview ? (
                        <form action={reviewDocumentAction} className="row" style={{ gap: "0.3rem" }}>
                          <input type="hidden" name="returnTo" value="/app/documents" />
                          <input type="hidden" name="documentId" value={document.id} />
                          <select name="status" defaultValue="approved" style={{ width: 110, padding: "0.2rem" }}>
                            <option value="in_review">In review</option><option value="approved">Approve</option><option value="rejected">Reject</option>
                          </select>
                          <input name="notes" placeholder="Note" style={{ width: 110, padding: "0.2rem" }} />
                          <button className="btn small secondary" type="submit">Save</button>
                        </form>
                      ) : null}
                      {canWrite ? (
                        <form action={deleteDocumentAction}>
                          <input type="hidden" name="returnTo" value="/app/documents" />
                          <input type="hidden" name="documentId" value={document.id} />
                          <button className="btn small danger" type="submit">Delete</button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "documents");
  }
}
