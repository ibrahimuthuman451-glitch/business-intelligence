import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listContacts } from "@/lib/finance-service";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { createCustomerAction, createSupplierAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Customers & suppliers" };
export const dynamic = "force-dynamic";

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org } = await requirePageContext("finance:read");
  const canWrite = org.permissions.includes("finance:write");
  try {
    const { customers, suppliers } = await listContacts(getDb(), org);
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Customers & suppliers" description="Contacts used on sales, expenses and invoices." />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Customers</h2><span className="small muted">{customers.length}</span></div>
            {customers.length === 0 ? <EmptyState title="No customers yet">Add customers to attach them to invoices.</EmptyState> : (
              <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Email</th><th>TIN</th></tr></thead><tbody>{customers.map((customer) => <tr key={customer.id}><td>{customer.name}</td><td className="small">{customer.email ?? "-"}</td><td className="mono small">{customer.tin ?? "-"}</td></tr>)}</tbody></table></div>
            )}
            {canWrite ? (
              <form action={createCustomerAction} className="card-pad">
                <input type="hidden" name="returnTo" value="/app/contacts" />
                <div className="form-grid">
                  <div className="field"><label htmlFor="customer-name">Name</label><input id="customer-name" name="name" required /></div>
                  <div className="field"><label htmlFor="customer-email">Email</label><input id="customer-email" name="email" type="email" /></div>
                  <div className="field"><label htmlFor="customer-tin">TIN</label><input id="customer-tin" name="tin" /></div>
                  <div className="field"><label htmlFor="customer-phone">Phone</label><input id="customer-phone" name="phone" /></div>
                </div>
                <button className="btn secondary" type="submit">Add customer</button>
              </form>
            ) : null}
          </div>
          <div className="card">
            <div className="card-head"><h2>Suppliers</h2><span className="small muted">{suppliers.length}</span></div>
            {suppliers.length === 0 ? <EmptyState title="No suppliers yet">Add suppliers to link purchases to vendors.</EmptyState> : (
              <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Email</th><th>TIN</th></tr></thead><tbody>{suppliers.map((supplier) => <tr key={supplier.id}><td>{supplier.name}</td><td className="small">{supplier.email ?? "-"}</td><td className="mono small">{supplier.tin ?? "-"}</td></tr>)}</tbody></table></div>
            )}
            {canWrite ? (
              <form action={createSupplierAction} className="card-pad">
                <input type="hidden" name="returnTo" value="/app/contacts" />
                <div className="form-grid">
                  <div className="field"><label htmlFor="supplier-name">Name</label><input id="supplier-name" name="name" required /></div>
                  <div className="field"><label htmlFor="supplier-email">Email</label><input id="supplier-email" name="email" type="email" /></div>
                  <div className="field"><label htmlFor="supplier-tin">TIN</label><input id="supplier-tin" name="tin" /></div>
                  <div className="field"><label htmlFor="supplier-phone">Phone</label><input id="supplier-phone" name="phone" /></div>
                </div>
                <button className="btn secondary" type="submit">Add supplier</button>
              </form>
            ) : null}
          </div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "contacts");
  }
}
