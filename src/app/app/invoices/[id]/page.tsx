import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { getInvoice } from "@/lib/finance-service";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Alert, Badge, PageHeader } from "@/components/ui";
import { recordPaymentAction, setInvoiceStatusAction } from "../../actions";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { org } = await requirePageContext("finance:read");
  const canWrite = org.permissions.includes("finance:write");
  let data: Awaited<ReturnType<typeof getInvoice>>;
  try {
    data = await getInvoice(getDb(), org, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { invoice, items, payments, customerName, paidCents, balanceCents } = data;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        eyebrow={org.orgName}
        title={`Invoice ${invoice.number}`}
        description={`${customerName ?? "No customer"} · issued ${formatDate(invoice.issueDate)} · due ${formatDate(invoice.dueDate)}`}
        actions={<Link className="btn secondary" href="/app/invoices">Back to invoices</Link>}
      />
      {query.ok ? <Alert tone="success">{query.ok}</Alert> : null}
      {query.error ? <Alert tone="error">{query.error}</Alert> : null}

      <div className="grid grid-3 section">
        <div className="card stat"><div className="label">Invoice total</div><div className="value">{formatMoney(invoice.totalCents, invoice.currency)}</div><div className="note">Tax {formatMoney(invoice.taxCents, invoice.currency)}</div></div>
        <div className="card stat green"><div className="label">Paid</div><div className="value">{formatMoney(paidCents, invoice.currency)}</div></div>
        <div className="card stat red"><div className="label">Balance</div><div className="value">{formatMoney(balanceCents, invoice.currency)}</div><div className="note"><Badge value={invoice.status} /></div></div>
      </div>

      <div className="grid grid-2 section">
        <div className="card">
          <div className="card-head"><h2>Line items</h2><span className="small muted">{items.length}</span></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Description</th><th className="right">Qty</th><th className="right">Unit</th><th className="right">Tax</th><th className="right">Total</th></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}><td>{item.description}</td><td className="right">{item.quantity}</td><td className="right mono">{formatMoney(item.unitPriceCents, invoice.currency)}</td><td className="right">{item.taxRateBp / 100}%</td><td className="right mono">{formatMoney(item.lineTotalCents, invoice.currency)}</td></tr>
            ))}</tbody>
          </table></div>
          <div className="card-pad">
            <div className="row-between small"><span>Subtotal</span><span className="mono">{formatMoney(invoice.subtotalCents, invoice.currency)}</span></div>
            <div className="row-between small"><span>Tax</span><span className="mono">{formatMoney(invoice.taxCents, invoice.currency)}</span></div>
            <div className="row-between strong"><span>Total</span><span className="mono">{formatMoney(invoice.totalCents, invoice.currency)}</span></div>
            {invoice.notes ? <p className="small muted mt-2 mb-0">{invoice.notes}</p> : null}
          </div>
        </div>

        <div className="stack">
          {canWrite && invoice.status !== "void" && invoice.status !== "draft" && balanceCents > 0 ? (
            <div className="card">
              <div className="card-head"><h2>Record payment</h2></div>
              <form action={recordPaymentAction} className="card-pad">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <div className="field"><label htmlFor="amount">Amount ({invoice.currency})</label><input id="amount" name="amount" required inputMode="decimal" placeholder={String(balanceCents)} /></div>
                <div className="form-grid">
                  <div className="field"><label htmlFor="paidAt">Paid on</label><input id="paidAt" name="paidAt" type="date" defaultValue={today} required /></div>
                  <div className="field"><label htmlFor="method">Method</label><select id="method" name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="mobile_money">Mobile money</option><option value="cash">Cash</option><option value="cheque">Cheque</option></select></div>
                </div>
                <div className="field"><label htmlFor="reference">Reference</label><input id="reference" name="reference" /></div>
                <button className="btn accent" type="submit">Save payment</button>
              </form>
            </div>
          ) : null}

          {canWrite ? (
            <div className="card">
              <div className="card-head"><h2>Invoice status</h2></div>
              <form action={setInvoiceStatusAction} className="card-pad inline-form">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <div className="field"><label htmlFor="status">Change to</label><select id="status" name="status" defaultValue={invoice.status === "draft" ? "sent" : "void"}>{invoice.status === "draft" ? <option value="sent">Issued</option> : null}<option value="void">Void</option>{invoice.status === "void" ? <option value="draft">Draft</option> : null}</select></div>
                <button className="btn secondary" type="submit">Update</button>
              </form>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head"><h2>Payments</h2><span className="small muted">{payments.length}</span></div>
            {payments.length === 0 ? <div className="empty small">No payments recorded yet.</div> : (
              <ul className="list card-pad">
                {payments.map((payment) => (
                  <li key={payment.id} className="row-between"><div><div className="strong small">{formatMoney(payment.amountCents, invoice.currency)}</div><div className="tiny muted">{formatDate(payment.paidAt)} · {payment.method.replace("_", " ")}{payment.reference ? ` · ${payment.reference}` : ""}</div></div></li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
