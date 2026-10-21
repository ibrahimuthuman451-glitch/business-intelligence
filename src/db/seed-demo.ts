import { and, eq, inArray, like, or } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  auditEvents,
  bidChecklists,
  businessProfiles,
  memberships,
  organizations,
  tasks,
  tenders,
  users,
} from "./schema";
import { registerUser, verifyEmail } from "@/lib/auth";
import { authorizeOrg, loadActor, type OrgContext } from "@/lib/authz";
import {
  createCustomer,
  createExpense,
  createInvoice,
  createSale,
  recordPayment,
} from "@/lib/finance-service";
import { createDocument, createDocumentRequest } from "@/lib/documents";
import { acceptInvitationForUser, grantAdvisorAccess } from "@/lib/team";
import { assessTenderFit, ensureChecklist } from "@/lib/tenders";
import { runReconciliation } from "@/lib/reconciliation";

export const DEMO_OWNER_EMAIL = "demo@ledgerline.local";
export const DEMO_ADVISOR_EMAIL = "advisor@demo-firm.local";
export const DEMO_PASSWORD = "DemoPassword9!";

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function demoContext(db: AppDb, userId: string, orgId: string): Promise<OrgContext> {
  const actor = await loadActor(db, userId);
  if (!actor) throw new Error("Demo actor could not be loaded");
  return authorizeOrg(db, actor, orgId, "org:read");
}

export async function removeDemoWorkspace(db: AppDb): Promise<void> {
  const demoUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [DEMO_OWNER_EMAIL, DEMO_ADVISOR_EMAIL]));
  const userIds = demoUsers.map((row) => row.id);
  if (userIds.length === 0) return;

  const memberOrgs = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(inArray(memberships.userId, userIds));
  const slugOrgs = await db
    .select({ orgId: organizations.id })
    .from(organizations)
    .where(like(organizations.slug, "sample-%"));
  const orgIds = [...new Set([...memberOrgs, ...slugOrgs].map((row) => row.orgId))];
  if (orgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  await db.delete(auditEvents).where(or(eq(auditEvents.actorEmail, DEMO_OWNER_EMAIL), eq(auditEvents.actorEmail, DEMO_ADVISOR_EMAIL)));
  await db.delete(tenders).where(and(eq(tenders.provenance, "sample"), like(tenders.reference, "SAMPLE-%")));
  await db.delete(users).where(inArray(users.id, userIds));
}

export type SeedResult = {
  created: boolean;
  ownerEmail: string;
  advisorEmail: string;
  password: string;
  organizationId?: string;
};

export async function seedDemoWorkspace(
  db: AppDb,
  options: { reset?: boolean } = {},
): Promise<SeedResult> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_OWNER_EMAIL))
    .limit(1);

  if (existing && !options.reset) {
    return { created: false, ownerEmail: DEMO_OWNER_EMAIL, advisorEmail: DEMO_ADVISOR_EMAIL, password: DEMO_PASSWORD };
  }
  if (existing) await removeDemoWorkspace(db);

  const registration = await registerUser(db, {
    name: "Demo Owner",
    email: DEMO_OWNER_EMAIL,
    password: DEMO_PASSWORD,
    organizationName: "Sample Trading Ltd (demo)",
    currency: "RWF",
  });
  await verifyEmail(db, registration.emailVerificationToken);
  await db
    .update(organizations)
    .set({ plan: "demo" })
    .where(eq(organizations.id, registration.organizationId));
  await db
    .update(businessProfiles)
    .set({
      sector: "construction",
      city: "Kigali",
      keywords: ["roads", "drainage", "supply"],
      tin: "SAMPLE-TIN-001",
      registrationNumber: "SAMPLE-RDB-001",
      contactEmail: DEMO_OWNER_EMAIL,
    })
    .where(eq(businessProfiles.orgId, registration.organizationId));

  const ctx = await demoContext(db, registration.userId, registration.organizationId);

  const customer = await createCustomer(db, ctx, {
    name: "SAMPLE Customer - Kigali Retail",
    email: "sample.customer@example.com",
    tin: "SAMPLE-TIN-002",
  });
  await createCustomer(db, ctx, {
    name: "SAMPLE Customer - Musanze Cooperative",
    email: "sample.coop@example.com",
  });

  await createSale(db, ctx, {
    description: "[SAMPLE] Wholesale order",
    amount: "2400000",
    tax: "432000",
    occurredAt: daysAgo(20),
    customerId: customer.id,
  });
  await createSale(db, ctx, {
    description: "[SAMPLE] Consultancy retainer",
    amount: "800000",
    tax: "144000",
    occurredAt: daysAgo(5),
  });
  await createExpense(db, ctx, {
    description: "[SAMPLE] Warehouse rent",
    amount: "350000",
    occurredAt: daysAgo(18),
    category: "rent",
    reference: "SAMPLE-RENT-1",
  });
  await createExpense(db, ctx, {
    description: "[SAMPLE] Vehicle maintenance",
    amount: "95000",
    occurredAt: daysAgo(3),
    category: "transport",
    reference: "SAMPLE-SUP-2",
  });

  const invoice = await createInvoice(db, ctx, {
    customerId: customer.id,
    number: "SAMPLE-INV-001",
    issueDate: daysAgo(10),
    dueDate: daysAhead(20),
    status: "sent",
    notes: "SAMPLE invoice for demonstration. Not a real tax document.",
    lines: [
      { description: "[SAMPLE] Supply of goods", quantity: 10, unitPrice: "120000", taxRatePercent: "18" },
      { description: "[SAMPLE] Delivery", quantity: 1, unitPrice: "50000", taxRatePercent: "0" },
    ],
  });
  await recordPayment(db, ctx, {
    invoiceId: invoice.id,
    amount: "500000",
    paidAt: daysAgo(2),
    reference: "SAMPLE-PAYMENT-1",
  });

  const bankStatement = await createDocument(db, ctx, {
    filename: "SAMPLE-bank-statement.pdf",
    declaredMimeType: "application/pdf",
    bytes: PDF,
    category: "bank",
    periodStart: daysAgo(31),
    periodEnd: daysAgo(1),
  });
  await createDocument(db, ctx, {
    filename: "SAMPLE-sales-ledger.csv",
    declaredMimeType: "text/csv",
    bytes: Buffer.from("Invoice Number,Total,Date\nSAMPLE-INV-001,1466000," + daysAgo(10) + "\n"),
    category: "sales",
    periodStart: daysAgo(31),
    periodEnd: daysAgo(1),
  });

  const samples = [
    {
      reference: "SAMPLE-2026-001",
      title: "SAMPLE - Supply of office furniture (demonstration only)",
      buyer: "Sample Public Agency",
      category: "supplies",
      region: "Kigali",
      closesAt: new Date(Date.now() + 14 * 86_400_000),
    },
    {
      reference: "SAMPLE-2026-002",
      title: "SAMPLE - Feeder road maintenance (demonstration only)",
      buyer: "Sample District",
      category: "construction",
      region: "Kigali",
      closesAt: new Date(Date.now() + 21 * 86_400_000),
    },
  ];
  for (const sample of samples) {
    await db.insert(tenders).values({
      orgId: null,
      ...sample,
      currency: "RWF",
      sourceUrl: "https://example.org/sample-procurement-notice",
      provenance: "sample",
      verifiedAt: new Date(),
      description:
        "Demonstration record only. This is not a real procurement notice; do not bid on it.",
    });
  }
  const [sampleTender] = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(eq(tenders.reference, "SAMPLE-2026-002"))
    .limit(1);
  if (sampleTender) {
    await assessTenderFit(db, ctx, sampleTender.id);
    const checklist = await ensureChecklist(db, ctx, sampleTender.id);
    if (checklist.items[0]) {
      await db.update(bidChecklists).set({ status: "in_progress" }).where(eq(bidChecklists.id, checklist.id));
    }
  }

  await runReconciliation(db, ctx, {
    source: "ebm_sales",
    filename: "SAMPLE-sales-report.csv",
    bytes: Buffer.from(
      "Invoice Number,Total,Date\nSAMPLE-INV-001,1466000," +
        daysAgo(10) +
        "\nSAMPLE-INV-999,250000," +
        daysAgo(4) +
        "\n",
    ),
    mapping: { invoiceNumber: "Invoice Number", amount: "Total", date: "Date" },
  });

  await db.insert(tasks).values([
    {
      orgId: registration.organizationId,
      title: "[SAMPLE] Review Q2 sales reconciliation",
      description: "Check the finding for SAMPLE-INV-999 with the advisor.",
      dueDate: daysAhead(2),
      status: "open",
      priority: "high",
      assigneeUserId: registration.userId,
      createdBy: registration.userId,
    },
    {
      orgId: registration.organizationId,
      title: "[SAMPLE] Upload March bank statement",
      description: "Requested by the demo advisor.",
      dueDate: daysAgo(1),
      status: "open",
      priority: "normal",
      assigneeUserId: registration.userId,
      createdBy: registration.userId,
    },
  ]);

  // Advisor firm + explicit client authorization + pending document request.
  const advisorRegistration = await registerUser(db, {
    name: "Demo Advisor",
    email: DEMO_ADVISOR_EMAIL,
    password: DEMO_PASSWORD,
    organizationName: "Demo Advisory Firm",
    organizationKind: "accounting_firm",
    currency: "RWF",
  });
  await verifyEmail(db, advisorRegistration.emailVerificationToken);
  await db
    .update(organizations)
    .set({ plan: "demo" })
    .where(eq(organizations.id, advisorRegistration.organizationId));

  const grant = await grantAdvisorAccess(db, ctx, {
    advisorEmail: DEMO_ADVISOR_EMAIL,
    firmOrgId: advisorRegistration.organizationId,
  });
  await acceptInvitationForUser(db, grant.token, advisorRegistration.userId);

  const advisorCtx = await demoContext(db, advisorRegistration.userId, registration.organizationId);
  await createDocumentRequest(db, advisorCtx, {
    title: "[SAMPLE] March purchase invoices",
    description: "Please upload the purchase invoices for the March reconciliation.",
    dueDate: daysAhead(5),
    periodStart: daysAgo(31),
    periodEnd: daysAgo(1),
  });

  return {
    created: true,
    ownerEmail: DEMO_OWNER_EMAIL,
    advisorEmail: DEMO_ADVISOR_EMAIL,
    password: DEMO_PASSWORD,
    organizationId: registration.organizationId,
  };
}
