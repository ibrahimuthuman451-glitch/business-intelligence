import Link from "next/link";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listContacts } from "@/lib/finance-service";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { InvoiceForm } from "@/components/invoice-form";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "New invoice" };
export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const { org } = await requirePageContext("finance:write");
  const db = getDb();
  const contacts = await listContacts(db, org);
  const [organization] = await db
    .select({ currency: organizations.defaultCurrency })
    .from(organizations)
    .where(eq(organizations.id, org.orgId))
    .limit(1);
  const currency = organization?.currency ?? "RWF";
  return (
    <>
      <PageHeader eyebrow={org.orgName} title="New invoice" description="Amounts are stored in minor units; totals shown here are derived on the server." actions={<Link className="btn secondary" href="/app/invoices">Cancel</Link>} />
      <div className="card card-pad">
        <InvoiceForm customers={contacts.customers.map((customer) => ({ id: customer.id, name: customer.name }))} currency={currency} />
      </div>
    </>
  );
}
