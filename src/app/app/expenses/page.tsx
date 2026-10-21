import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listContacts, listExpenses } from "@/lib/finance-service";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { createExpenseAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Expenses" };
export const dynamic = "force-dynamic";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  const canWrite = org.permissions.includes("finance:write");
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [expenses, contacts] = await Promise.all([listExpenses(db, org), listContacts(db, org)]);
    const total = expenses.reduce((sum, row) => sum + row.amountCents, 0);
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Expenses" description="Purchases and operating costs, with supplier links for reconciliation." />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        {canWrite ? (
          <div className="card section">
            <div className="card-head"><h2>Record an expense</h2></div>
            <form action={createExpenseAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/expenses" />
              <div className="form-grid">
                <div className="field"><label htmlFor="description">Description</label><input id="description" name="description" required minLength={2} placeholder="Office rent - March" /></div>
                <div className="field"><label htmlFor="supplierId">Supplier (optional)</label><select id="supplierId" name="supplierId" defaultValue=""><option value="">No supplier</option>{contacts.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></div>
                <div className="field"><label htmlFor="category">Category</label><select id="category" name="category" defaultValue="general"><option value="general">General</option><option value="rent">Rent</option><option value="salaries">Salaries</option><option value="utilities">Utilities</option><option value="transport">Transport</option><option value="professional">Professional services</option><option value="taxes">Taxes</option></select></div>
                <div className="field"><label htmlFor="amount">Amount</label><input id="amount" name="amount" inputMode="decimal" required placeholder="120000" /></div>
                <div className="field"><label htmlFor="tax">Tax included (optional)</label><input id="tax" name="tax" inputMode="decimal" placeholder="0" /></div>
                <div className="field"><label htmlFor="occurredAt">Date</label><input id="occurredAt" name="occurredAt" type="date" required defaultValue={today} /></div>
                <div className="field"><label htmlFor="reference">Supplier reference</label><input id="reference" name="reference" placeholder="SUP-8831" /></div>
              </div>
              <button className="btn accent" type="submit">Record expense</button>
            </form>
          </div>
        ) : null}
        <div className="card section">
          <div className="card-head"><h2>Expense ledger</h2><span className="small muted">{expenses.length} entries · {formatMoney(total, expenses[0]?.currency ?? "RWF")}</span></div>
          {expenses.length === 0 ? (
            <EmptyState title="No expenses recorded">Record a purchase to build your cost base.</EmptyState>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Supplier</th><th className="right">Net</th><th className="right">Tax</th></tr></thead>
              <tbody>{expenses.map((expense) => (
                <tr key={expense.id}><td className="nowrap">{formatDate(expense.occurredAt)}</td><td>{expense.description}</td><td><span className="badge gray">{expense.category}</span></td><td>{expense.supplierName ?? "-"}</td><td className="right mono">{formatMoney(expense.amountCents, expense.currency)}</td><td className="right mono muted">{formatMoney(expense.taxCents, expense.currency)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "expenses");
  }
}
