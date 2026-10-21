import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tenders } from "@/db/schema";
import {
  assessTenderFit,
  ensureChecklist,
  getTender,
  importTender,
  listTenders,
  scoreTenderRelevance,
  toggleChecklistItem,
} from "@/lib/tenders";
import { createOrg, createTestContext, reloadActor, type TestContext } from "./helpers";
import { authorizeOrg } from "@/lib/authz";
import { ForbiddenError, ValidationError } from "@/lib/errors";

let context: TestContext;
const future = new Date(Date.now() + 20 * 86_400_000).toISOString();

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("verified tender intake", () => {
  it("stores provenance, source URL and a verification timestamp", async () => {
    const org = await createOrg(context.db, { email: "tender@example.com", orgName: "Tender Co" });
    const created = await importTender(context.db, org.ctx, {
      reference: "RW-2026-001",
      title: "Rehabilitation of feeder roads",
      buyer: "City of Kigali",
      category: "construction",
      region: "Kigali",
      budget: "50000000",
      closesAt: future,
      sourceName: "Official procurement portal",
      sourceUrl: "https://procurement.example.gov.rw/notice/RW-2026-001",
    });

    const tender = await getTender(context.db, org.ctx, created.id);
    expect(tender.provenance).toBe("manual_import");
    expect(tender.verifiedAt).toBeInstanceOf(Date);
    expect(tender.sourceUrl).toContain("procurement.example.gov.rw");
    expect(tender.sourceName).toBe("Official procurement portal");
    expect(tender.budgetCents).toBe(50000000);
    expect(tender.daysLeft).toBeGreaterThan(0);
    expect(tender.closed).toBe(false);
  });

  it("rejects duplicate references, invalid URLs and impossible dates", async () => {
    const org = await createOrg(context.db, { email: "tender-invalid@example.com", orgName: "Tender Invalid" });
    const payload = {
      reference: "DUP-1",
      title: "Waste collection services",
      closesAt: future,
      sourceUrl: "https://example.org/notice/1",
    };
    await importTender(context.db, org.ctx, payload);
    await expect(importTender(context.db, org.ctx, payload)).rejects.toThrow(/already exists/i);

    await expect(
      importTender(context.db, org.ctx, {
        reference: "BAD-URL",
        title: "Invalid source",
        closesAt: future,
        sourceUrl: "javascript:alert(1)",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      importTender(context.db, org.ctx, {
        reference: "BAD-DATE",
        title: "Invalid date",
        closesAt: "not-a-date",
        sourceUrl: "https://example.org/notice/2",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("labels sample tenders and never presents them as imported notices", async () => {
    const org = await createOrg(context.db, { email: "sample@example.com", orgName: "Sample Co" });
    await context.db.insert(tenders).values({
      orgId: null,
      reference: "SAMPLE-001",
      title: "SAMPLE - Practice notice for demonstration only",
      closesAt: new Date(Date.now() + 10 * 86_400_000),
      sourceUrl: "https://example.org/sample-notice",
      provenance: "sample",
      verifiedAt: new Date(),
    });

    const rows = await listTenders(context.db, org.ctx, { status: "all" });
    const sample = rows.find((row) => row.reference === "SAMPLE-001");
    expect(sample?.provenance).toBe("sample");

    const visible = await getTender(context.db, org.ctx, sample!.id);
    expect(visible.provenance).toBe("sample");
    expect(visible.title.startsWith("SAMPLE")).toBe(true);
  });

  it("computes relevance separately from undetermined eligibility", () => {
    const result = scoreTenderRelevance(
      {
        title: "Construction of drainage channels in Kigali",
        description: "Road works and drainage",
        category: "construction",
        region: "Kigali",
        buyer: "City of Kigali",
      },
      { sector: "construction", city: "Kigali", keywords: ["drainage", "roads"] },
    );
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.eligibility).toBe("unknown");
    expect(result.reasons.join(" ")).toMatch(/drainage/i);
    expect(result.reasons.join(" ")).toMatch(/eligibility/i);
  });

  it("builds a bid-readiness checklist that only becomes ready when required items are done", async () => {
    const org = await createOrg(context.db, { email: "checklist@example.com", orgName: "Checklist Co" });
    const tender = await importTender(context.db, org.ctx, {
      reference: "CHK-1",
      title: "Office supplies framework",
      closesAt: future,
      sourceUrl: "https://example.org/notice/chk-1",
    });

    const checklist = await ensureChecklist(context.db, org.ctx, tender.id);
    expect(checklist.status).toBe("draft");
    expect(checklist.items.length).toBeGreaterThanOrEqual(8);

    await toggleChecklistItem(context.db, org.ctx, checklist.items[0]!.id, true);
    let current = await ensureChecklist(context.db, org.ctx, tender.id);
    expect(current.status).toBe("in_progress");

    for (const item of current.items) {
      await toggleChecklistItem(context.db, org.ctx, item.id, true);
    }
    current = await ensureChecklist(context.db, org.ctx, tender.id);
    expect(current.status).toBe("ready");

    await toggleChecklistItem(context.db, org.ctx, current.items[0]!.id, false);
    current = await ensureChecklist(context.db, org.ctx, tender.id);
    expect(current.status).toBe("in_progress");
  });

  it("does not let an advisor without tender-write permission import notices", async () => {
    const client = await createOrg(context.db, { email: "tender-client@example.com", orgName: "Tender Client" });
    const advisor = await createOrg(context.db, {
      email: "tender-advisor@example.com",
      orgName: "Tender Advisors",
      kind: "accounting_firm",
    });
    const { memberships } = await import("@/db/schema");
    await context.db.insert(memberships).values({
      orgId: client.orgId,
      userId: advisor.userId,
      role: "advisor",
      status: "active",
    });
    const advisorCtx = await authorizeOrg(
      context.db,
      await reloadActor(context.db, advisor.userId),
      client.orgId,
      "tenders:read",
    );
    await expect(
      importTender(context.db, advisorCtx, {
        reference: "ADV-1",
        title: "Advisor should not import",
        closesAt: future,
        sourceUrl: "https://example.org/notice/adv-1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("assesses fit using the organization's own profile", async () => {
    const org = await createOrg(context.db, { email: "assess@example.com", orgName: "Assess Co" });
    await context.db
      .update((await import("@/db/schema")).businessProfiles)
      .set({ sector: "construction", city: "Kigali", keywords: ["roads"] })
      .where(eq((await import("@/db/schema")).businessProfiles.orgId, org.orgId));
    const tender = await importTender(context.db, org.ctx, {
      reference: "ASSESS-1",
      title: "Road construction in Kigali",
      category: "construction",
      region: "Kigali",
      closesAt: future,
      sourceUrl: "https://example.org/notice/assess-1",
    });
    const result = await assessTenderFit(context.db, org.ctx, tender.id);
    expect(result.score).toBeGreaterThan(0);
    expect(result.eligibility).toBe("unknown");
    const reloaded = await getTender(context.db, org.ctx, tender.id);
    expect(reloaded.match?.relevanceScore).toBe(result.score);
  });
});
