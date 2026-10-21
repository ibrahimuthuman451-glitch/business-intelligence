import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listContacts, listSales } from "@/lib/finance-service";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { createSaleAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Sales" };
export const dynamic = "force-dynamic";

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  const canWrite = org.permissions.includes("finance:write");
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [sales, contacts] = await Promise.all([listSales(db, org), listContacts(db, org)]);
    const total = sales.reduce((sum, row) => sum + row.amountCents, 0);
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Sales" description="Recorded revenue, net of tax. Totals feed the dashboard immediately." />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}

        {canWrite ? (
          <div className="card section">
            <div className="card-head"><h2>Record a sale</h2><span className="tiny muted">Amounts in {org.actor.memberships.find((m) => m.orgId === org.orgId) ? "organization currency" : "currency"}</span></div>
            <form action={createSaleAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/sales" />
              <div className="form-grid">
                <div className="field"><label htmlFor="description">Description</label><input id="description" name="description" required minLength={2} placeholder="Consulting services - March" /></div>
                <div className="field"><label htmlFor="customerId">Customer (optional)</label><select id="customerId" name="customerId" defaultValue=""><option value="">No customer</option>{contacts.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></div>
                <div className="field"><label htmlFor="amount">Amount</label><input id="amount" name="amount" inputMode="decimal" required placeholder="250000" /></div>
                <div className="field"><label htmlFor="tax">Tax included (optional)</label><input id="tax" name="tax" inputMode="decimal" placeholder="0" /></div>
                <div className="field"><label htmlFor="occurredAt">Date</label><input id="occurredAt" name="occurredAt" type="date" required defaultValue={today} /></div>
                <div className="field"><label htmlFor="reference">Reference (optional)</label><input id="reference" name="reference" placeholder="INV-1042" /></div>
              </div>
              <button className="btn accent" type="submit">Record sale</button>
            </form>
          </div>
        ) : null}

        <div className="card section">
          <div className="card-head"><h2>Sales ledger</h2><span className="small muted">{sales.length} entries · {formatMoney(total, sales[0]?.currency ?? "RWF")}</span></div>
          {sales.length === 0 ? (
            <EmptyState title="No sales recorded">Add your first sale above; it will appear in reports and reconciliation.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Description</th><th>Customer</th><th>Reference</th><th className="right">Net</th><th className="right">Tax</th></tr></thead>
              <tbody>{sales.map((sale) => (
                <tr key={sale.id}><td className="nowrap">{formatDate(sale.occurredAt)}</td><td>{sale.description}</td><td>{sale.customerName ?? "-"}</td><td className="mono small">{sale.reference ?? "-"}</td><td className="right mono">{formatMoney(sale.amountCents, sale.currency)}</td><td className="right mono muted">{formatMoney(sale.taxCents, sale.currency)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "sales");
  }
}
