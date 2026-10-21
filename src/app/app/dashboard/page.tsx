import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { getDashboardData, listInvoices } from "@/lib/finance-service";
import { listDocuments } from "@/lib/documents";
import { listTenders } from "@/lib/tenders";
import { requirePageContext } from "@/lib/current-user";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; verify?: string }>;
}) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  const db = getDb();

  try {
    const { summary, months, currency } = await getDashboardData(db, org);
    const invoices = await listInvoices(db, org);
    const documents = await listDocuments(db, org.orgId);
    const tenders = await listTenders(db, org, { status: "open" });
    const maxMonth = Math.max(1, ...months.flatMap((month) => [month.revenueCents, month.expenseCents]));

    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title={`Good to see you, ${org.actor.user.name.split(" ")[0]}.`}
          description="Every figure below is calculated from records in this organization only."
          actions={
            <>
              <Link className="btn secondary" href="/app/invoices/new">New invoice</Link>
              <Link className="btn accent" href="/app/documents">Upload documents</Link>
            </>
          }
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        {params.verify ? (
          <Alert tone="info">
            Development mode: <Link href={params.verify}>verify your email now</Link>.
          </Alert>
        ) : null}

        <div className="grid grid-4 section">
          <div className="card stat green">
            <div className="label">Revenue recorded</div>
            <div className="value">{formatMoney(summary.revenueCents, currency)}</div>
            <div className="note">Gross profit {formatMoney(summary.grossProfitCents, currency)}</div>
          </div>
          <div className="card stat red">
            <div className="label">Outstanding receivables</div>
            <div className="value">{formatMoney(summary.outstandingCents, currency)}</div>
            <div className="note">{summary.unpaidInvoiceCount} unpaid invoice{summary.unpaidInvoiceCount === 1 ? "" : "s"}</div>
          </div>
          <div className="card stat accent">
            <div className="label">Overdue</div>
            <div className="value">{formatMoney(summary.overdueCents, currency)}</div>
            <div className="note">Aged from invoice due dates</div>
          </div>
          <div className="card stat blue">
            <div className="label">Net tax position</div>
            <div className="value">{formatMoney(summary.netTaxCents, currency)}</div>
            <div className="note">Tax on sales minus tax on expenses</div>
          </div>
        </div>

        <div className="grid grid-2 section">
          <div className="card">
            <div className="card-head">
              <h2>Revenue vs expenses</h2>
              <span className="tiny muted">Last 6 months</span>
            </div>
            <div className="card-pad">
              <div className="chart">
                {months.map((month) => (
                  <div className="col" key={month.month}>
                    <div className="pair">
                      <span className="rev" style={{ height: `${(month.revenueCents / maxMonth) * 100}%` }} />
                      <span className="exp" style={{ height: `${(month.expenseCents / maxMonth) * 100}%` }} />
                    </div>
                    <div className="label">{month.month.slice(5)}</div>
                  </div>
                ))}
              </div>
              <div className="legend mt-1">
                <span><i style={{ background: "var(--green)" }} />Revenue</span>
                <span><i style={{ background: "#d8a48c" }} />Expenses</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Receivables ageing</h2>
              <Link className="small" href="/app/invoices">All invoices</Link>
            </div>
            <div className="card-pad">
              {([
                ["Current", summary.aging.current],
                ["1-30 days", summary.aging.d1_30],
                ["31-60 days", summary.aging.d31_60],
                ["61-90 days", summary.aging.d61_90],
                ["90+ days", summary.aging.d90_plus],
              ] as const).map(([label, value]) => (
                <div key={label} className="mb-1">
                  <div className="row-between tiny">
                    <span>{label}</span>
                    <span className="mono">{formatMoney(value, currency)}</span>
                  </div>
                  <div className="bar">
                    <span style={{ width: `${summary.outstandingCents === 0 ? 0 : Math.min(100, (value / summary.outstandingCents) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-2 section">
          <div className="card">
            <div className="card-head">
              <h2>Recent invoices</h2>
              <Link className="small" href="/app/invoices">View all</Link>
            </div>
            {invoices.length === 0 ? (
              <EmptyState title="No invoices yet" action={<Link className="btn small" href="/app/invoices/new">Create the first one</Link>}>
                Invoices you issue will appear here with live balances.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Number</th><th>Customer</th><th>Due</th><th className="right">Balance</th><th>Status</th></tr></thead>
                  <tbody>
                    {invoices.slice(0, 6).map((invoice) => (
                      <tr key={invoice.id}>
                        <td><Link href={`/app/invoices/${invoice.id}`}>{invoice.number}</Link></td>
                        <td>{invoice.customerName ?? "-"}</td>
                        <td className="nowrap">{formatDate(invoice.dueDate)}</td>
                        <td className="right mono">{formatMoney(invoice.balanceCents, invoice.currency)}</td>
                        <td><Badge value={invoice.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="stack">
            <div className="card">
              <div className="card-head"><h2>Document room</h2><Link className="small" href="/app/documents">Open</Link></div>
              <div className="card-pad">
                <div className="row-between"><span className="muted small">Files stored privately</span><strong>{documents.length}</strong></div>
                <div className="row-between mt-1"><span className="muted small">Awaiting review</span><strong>{documents.filter((doc) => doc.status === "uploaded" || doc.status === "in_review").length}</strong></div>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Tender deadlines</h2><Link className="small" href="/app/tenders">Open</Link></div>
              {tenders.length === 0 ? (
                <EmptyState title="No open notices">Import a verified notice to start tracking deadlines.</EmptyState>
              ) : (
                <ul className="list card-pad">
                  {tenders.slice(0, 3).map((tender) => (
                    <li key={tender.id}>
                      <Link href={`/app/tenders/${tender.id}`}>{tender.title}</Link>
                      <div className="tiny muted">Closes {formatDate(tender.closesAt)} · {tender.daysLeft} day{tender.daysLeft === 1 ? "" : "s"} left</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "dashboard");
  }
}
