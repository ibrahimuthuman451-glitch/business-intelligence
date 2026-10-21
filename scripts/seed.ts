/**
 * Seeds a clearly-labelled demo workspace with sample data.
 * Safe to re-run: it exits early if the demo account already exists.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { organizations, tenders, users } from "../src/db/schema";
import { registerUser, verifyEmail } from "../src/lib/auth";
import { authorizeOrg, loadActor } from "../src/lib/authz";
import { createCustomer, createExpense, createInvoice, createSale, recordPayment } from "../src/lib/finance-service";
import { createDocument } from "../src/lib/documents";

const EMAIL = "demo@ledgerline.local";
const PASSWORD = "DemoPassword9!";
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_DEMO_DATA !== "true") {
    throw new Error("Refusing to seed demo data in production. Set SEED_DEMO_DATA=true to override.");
  }
  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL)).limit(1);
  if (existing) {
    console.log("Demo workspace already exists; nothing to do.");
    return;
  }

  const registration = await registerUser(db, {
    name: "Demo Owner",
    email: EMAIL,
    password: PASSWORD,
    organizationName: "Sample Trading Ltd (demo)",
    currency: "RWF",
  });
  await verifyEmail(db, registration.emailVerificationToken);
  await db.update(organizations).set({ plan: "demo" }).where(eq(organizations.id, registration.organizationId));

  const actor = await loadActor(db, registration.userId);
  if (!actor) throw new Error("Demo actor could not be loaded");
  const ctx = await authorizeOrg(db, actor, registration.organizationId, "org:read");

  const customer = await createCustomer(db, ctx, {
    name: "SAMPLE Customer - Kigali Retail",
    email: "sample.customer@example.com",
    tin: "SAMPLE-TIN-001",
  });

  await createSale(db, ctx, {
    description: "[SAMPLE] Wholesale order",
    amount: "2400000",
    tax: "432000",
    occurredAt: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10),
    customerId: customer.id,
  });
  await createSale(db, ctx, {
    description: "[SAMPLE] Consultancy retainer",
    amount: "800000",
    tax: "144000",
    occurredAt: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  });
  await createExpense(db, ctx, {
    description: "[SAMPLE] Warehouse rent",
    amount: "350000",
    occurredAt: new Date(Date.now() - 18 * 86400000).toISOString().slice(0, 10),
    category: "rent",
  });

  const invoice = await createInvoice(db, ctx, {
    customerId: customer.id,
    issueDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
    status: "sent",
    notes: "SAMPLE invoice for demonstration.",
    lines: [
      { description: "[SAMPLE] Supply of goods", quantity: 10, unitPrice: "120000", taxRatePercent: "18" },
    ],
  });
  await recordPayment(db, ctx, {
    invoiceId: invoice.id,
    amount: "500000",
    paidAt: new Date().toISOString().slice(0, 10),
    reference: "SAMPLE-PAYMENT",
  });

  await createDocument(db, ctx, {
    filename: "SAMPLE-bank-statement.pdf",
    declaredMimeType: "application/pdf",
    bytes: PDF,
    category: "bank",
    periodStart: new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
  });

  const samples = [
    {
      reference: "SAMPLE-2026-001",
      title: "SAMPLE - Supply of office furniture (demonstration only)",
      buyer: "Sample Public Agency",
      category: "supplies",
      region: "Kigali",
      closesAt: new Date(Date.now() + 14 * 86400000),
    },
    {
      reference: "SAMPLE-2026-002",
      title: "SAMPLE - Feeder road maintenance (demonstration only)",
      buyer: "Sample District",
      category: "construction",
      region: "Kigali",
      closesAt: new Date(Date.now() + 30 * 86400000),
    },
  ];

  for (const sample of samples) {
    await db.insert(tenders).values({
      orgId: null,
      ...sample,
      sourceUrl: "https://example.org/sample-procurement-notice",
      provenance: "sample",
      verifiedAt: new Date(),
      description:
        "Demonstration record only. This is not a real procurement notice; do not bid on it.",
    });
  }

  console.log("Demo workspace seeded.");
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log("  All records are labelled SAMPLE. Change the password before sharing.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
