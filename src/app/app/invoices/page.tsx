import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listInvoices } from "@/lib/finance-service";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  try {
    const invoices = await listInvoices(getDb(), org);
    const currency = invoices[0]?.currency ?? "RWF";
    const outstanding = invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0);
    const overdue = invoices.filter((invoice) => invoice.overdue).reduce((sum, invoice) => sum + invoice.balanceCents, 0);
    const paid = invoices.filter((invoice) => invoice.status === "paid").length;
    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Invoices"
          description="Totals and balances are derived from invoice lines and recorded payments."
          actions={org.permissions.includes("finance:write") ? <Link className="btn accent" href="/app/invoices/new">New invoice</Link> : null}
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="grid grid-3 section">
          <div className="card stat red"><div className="label">Outstanding</div><div className="value">{formatMoney(outstanding, currency)}</div></div>
          <div className="card stat accent"><div className="label">Overdue</div><div className="value">{formatMoney(overdue, currency)}</div></div>
          <div className="card stat green"><div className="label">Paid invoices</div><div className="value">{paid}</div></div>
        </div>
        <div className="card">
          <div className="card-head"><h2>All invoices</h2><span className="small muted">{invoices.length} total</span></div>
          {invoices.length === 0 ? (
            <EmptyState title="No invoices yet" action={<Link className="btn small" href="/app/invoices/new">Create an invoice</Link>}>Invoice customers and track what is still owed.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>Due</th><th className="right">Total</th><th className="right">Balance</th><th>Status</th></tr></thead>
              <tbody>{invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td><Link href={`/app/invoices/${invoice.id}`} className="strong">{invoice.number}</Link>{invoice.overdue ? <div className="tiny" style={{ color: "var(--red)" }}>overdue</div> : null}</td>
                  <td>{invoice.customerName ?? "-"}</td>
                  <td className="nowrap">{formatDate(invoice.issueDate)}</td>
                  <td className="nowrap">{formatDate(invoice.dueDate)}</td>
                  <td className="right mono">{formatMoney(invoice.totalCents, invoice.currency)}</td>
                  <td className="right mono">{formatMoney(invoice.balanceCents, invoice.currency)}</td>
                  <td><Badge value={invoice.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "invoices");
  }
}
