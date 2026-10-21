import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  bidChecklistItems,
  bidChecklists,
  businessProfiles,
  tenderMatches,
  tenderSources,
  tenders,
} from "@/db/schema";
import { recordAuditSafe } from "./audit";
import type { OrgContext } from "./authz";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { isUniqueViolation } from "./db-errors";

export type TenderMatchInput = {
  title: string;
  description?: string | null;
  category?: string | null;
  region?: string | null;
  buyer?: string | null;
};

export type MatchProfile = {
  sector?: string | null;
  city?: string | null;
  keywords?: string[] | null;
};

export type MatchResult = {
  score: number;
  reasons: string[];
  eligibility: "unknown" | "likely" | "unlikely";
};

function words(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

/**
 * Relevance is a keyword/sector heuristic. It is NOT an eligibility decision:
 * eligibility always requires checking the official notice and its mandatory
 * requirements, so it is reported as "unknown" unless a human sets it.
 */
export function scoreTenderRelevance(tender: TenderMatchInput, profile: MatchProfile): MatchResult {
  const haystack = [
    tender.title,
    tender.description ?? "",
    tender.category ?? "",
    tender.buyer ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const sector = (profile.sector ?? "").trim().toLowerCase();
  if (sector && haystack.includes(sector)) {
    score += 35;
    reasons.push(`Sector "${profile.sector}" appears in the notice`);
  }

  const category = (tender.category ?? "").trim().toLowerCase();
  if (sector && category && (category.includes(sector) || sector.includes(category))) {
    score += 20;
    reasons.push(`Notice category "${tender.category}" matches your sector`);
  }

  const keywordHits = (profile.keywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 1)
    .filter((keyword) => haystack.includes(keyword));
  if (keywordHits.length > 0) {
    score += Math.min(keywordHits.length * 15, 45);
    reasons.push(`Keyword match: ${keywordHits.join(", ")}`);
  }

  const city = (profile.city ?? "").trim().toLowerCase();
  const region = (tender.region ?? "").trim().toLowerCase();
  if (city && region && (city === region || region.includes(city))) {
    score += 10;
    reasons.push(`Region matches your location (${tender.region})`);
  }

  const titleWords = new Set(words(tender.title));
  const profileWords = new Set([
    ...words(profile.sector),
    ...(profile.keywords ?? []).flatMap((keyword) => words(keyword)),
  ]);
  let overlap = 0;
  for (const word of titleWords) if (profileWords.has(word)) overlap += 1;
  if (overlap > 0 && keywordHits.length === 0) score += Math.min(overlap * 10, 30);

  if (reasons.length === 0) {
    reasons.push("No sector, keyword or region signal matched this notice");
  }
  reasons.push(
    "Relevance only estimates fit. Eligibility must be verified against the official notice and its mandatory documents.",
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    eligibility: "unknown",
  };
}

function validateSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Source URL must be a full http(s) link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Source URL must use http or https");
  }
  return url.toString();
}

export type ImportTenderInput = {
  reference: string;
  title: string;
  buyer?: string | null;
  description?: string | null;
  category?: string | null;
  region?: string | null;
  budget?: string | number | null;
  publishedAt?: string | null;
  closesAt: string;
  sourceName?: string | null;
  sourceUrl: string;
};

/** Creates a tender from a verified, human-supplied official notice. */
export async function importTender(
  db: AppDb,
  ctx: OrgContext,
  input: ImportTenderInput,
  meta: { ipAddress?: string | null } = {},
): Promise<{ id: string }> {
  if (!ctx.permissions.includes("tenders:write")) throw new ForbiddenError();
  const reference = input.reference.trim();
  const title = input.title.trim();
  if (reference.length < 2) throw new ValidationError("Enter the official tender reference");
  if (title.length < 4) throw new ValidationError("Enter the tender title");

  const sourceUrl = validateSourceUrl(input.sourceUrl);
  const closesAt = new Date(input.closesAt);
  if (Number.isNaN(closesAt.getTime())) throw new ValidationError("Enter a valid closing date/time");
  if (input.publishedAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.publishedAt)) {
    throw new ValidationError("Published date must be YYYY-MM-DD");
  }

  let budgetCents: number | null = null;
  if (input.budget !== null && input.budget !== undefined && input.budget !== "") {
    const parsed = Number(String(input.budget).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(parsed) || parsed < 0) throw new ValidationError("Budget must be a number");
    budgetCents = Math.round(parsed);
  }

  const [duplicate] = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(and(eq(tenders.orgId, ctx.orgId), eq(tenders.reference, reference)))
    .limit(1);
  if (duplicate) throw new ConflictError("A tender with that reference already exists");

  const now = new Date();
  const host = new URL(sourceUrl).hostname;
  const sourceName = input.sourceName?.trim() || host;

  try {
    const row = await db.transaction(async (tx) => {
      const [existingSource] = await tx
        .select({ id: tenderSources.id })
        .from(tenderSources)
        .where(eq(tenderSources.url, sourceUrl))
        .limit(1);

      let sourceId = existingSource?.id;
      if (!sourceId) {
        const [source] = await tx
          .insert(tenderSources)
          .values({
            name: sourceName,
            url: sourceUrl,
            method: "manual_import",
            verifiedAt: now,
            verifiedBy: ctx.actor.user.id,
            notes: "Registered through verified manual import",
          })
          .returning({ id: tenderSources.id });
        sourceId = source?.id;
      }
      if (!sourceId) throw new AppError("Could not register tender source", 500);

      const [tender] = await tx
        .insert(tenders)
        .values({
          orgId: ctx.orgId,
          sourceId,
          reference,
          title,
          buyer: input.buyer?.trim() || null,
          description: input.description?.trim() || null,
          category: input.category?.trim() || null,
          region: input.region?.trim() || null,
          budgetCents,
          publishedAt: input.publishedAt || null,
          closesAt,
          sourceUrl,
          provenance: "manual_import",
          verifiedAt: now,
          createdBy: ctx.actor.user.id,
        })
        .returning({ id: tenders.id });
      if (!tender) throw new AppError("Could not save tender", 500);
      return tender;
    });

    await recordAuditSafe(db, {
      orgId: ctx.orgId,
      actorUserId: ctx.actor.user.id,
      actorEmail: ctx.actor.user.email,
      action: "tender.imported",
      entityType: "tender",
      entityId: row.id,
      metadata: { reference, sourceUrl, provenance: "manual_import" },
      ipAddress: meta.ipAddress,
    });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A tender with that reference already exists");
    }
    throw error;
  }
}

export type TenderFilters = {
  q?: string;
  category?: string;
  region?: string;
  status?: "open" | "closed" | "all";
};

export async function listTenders(db: AppDb, ctx: OrgContext, filters: TenderFilters = {}) {
  if (!ctx.permissions.includes("tenders:read")) throw new ForbiddenError();
  const conditions = [or(eq(tenders.orgId, ctx.orgId), eq(tenders.provenance, "sample"))];
  if (filters.q) {
    conditions.push(
      or(
        ilike(tenders.title, `%${filters.q}%`),
        ilike(tenders.reference, `%${filters.q}%`),
        ilike(tenders.buyer, `%${filters.q}%`),
      ),
    );
  }
  if (filters.category) conditions.push(eq(tenders.category, filters.category));
  if (filters.region) conditions.push(eq(tenders.region, filters.region));
  if (filters.status === "open") conditions.push(sql`${tenders.closesAt} > now()`);
  if (filters.status === "closed") conditions.push(sql`${tenders.closesAt} <= now()`);

  const rows = await db
    .select({
      id: tenders.id,
      reference: tenders.reference,
      title: tenders.title,
      buyer: tenders.buyer,
      category: tenders.category,
      region: tenders.region,
      currency: tenders.currency,
      budgetCents: tenders.budgetCents,
      closesAt: tenders.closesAt,
      sourceUrl: tenders.sourceUrl,
      provenance: tenders.provenance,
      verifiedAt: tenders.verifiedAt,
      matchScore: tenderMatches.relevanceScore,
      eligibility: tenderMatches.eligibility,
      checklistId: bidChecklists.id,
      checklistStatus: bidChecklists.status,
    })
    .from(tenders)
    .leftJoin(
      tenderMatches,
      and(eq(tenderMatches.tenderId, tenders.id), eq(tenderMatches.orgId, ctx.orgId)),
    )
    .leftJoin(
      bidChecklists,
      and(eq(bidChecklists.tenderId, tenders.id), eq(bidChecklists.orgId, ctx.orgId)),
    )
    .where(and(...conditions))
    .orderBy(asc(tenders.closesAt))
    .limit(200);

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    daysLeft: Math.ceil((row.closesAt.getTime() - now) / 86_400_000),
    closed: row.closesAt.getTime() <= now,
  }));
}

export async function getTender(db: AppDb, ctx: OrgContext, tenderId: string) {
  if (!ctx.permissions.includes("tenders:read")) throw new ForbiddenError();
  const [row] = await db
    .select({
      tender: tenders,
      sourceName: tenderSources.name,
      sourceMethod: tenderSources.method,
      sourceVerifiedAt: tenderSources.verifiedAt,
    })
    .from(tenders)
    .leftJoin(tenderSources, eq(tenderSources.id, tenders.sourceId))
    .where(
      and(
        eq(tenders.id, tenderId),
        or(eq(tenders.orgId, ctx.orgId), eq(tenders.provenance, "sample")),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Tender not found");

  const [match] = await db
    .select()
    .from(tenderMatches)
    .where(and(eq(tenderMatches.tenderId, tenderId), eq(tenderMatches.orgId, ctx.orgId)))
    .limit(1);

  const checklist = await getChecklist(db, ctx, tenderId);
  return {
    ...row.tender,
    sourceName: row.sourceName,
    sourceMethod: row.sourceMethod,
    sourceVerifiedAt: row.sourceVerifiedAt,
    match: match ?? null,
    checklist,
    daysLeft: Math.ceil((row.tender.closesAt.getTime() - Date.now()) / 86_400_000),
    closed: row.tender.closesAt.getTime() <= Date.now(),
  };
}

export async function assessTenderFit(db: AppDb, ctx: OrgContext, tenderId: string) {
  if (!ctx.permissions.includes("tenders:read")) throw new ForbiddenError();
  const [tender] = await db
    .select()
    .from(tenders)
    .where(
      and(
        eq(tenders.id, tenderId),
        or(eq(tenders.orgId, ctx.orgId), eq(tenders.provenance, "sample")),
      ),
    )
    .limit(1);
  if (!tender) throw new NotFoundError("Tender not found");

  const [profile] = await db
    .select({
      sector: businessProfiles.sector,
      city: businessProfiles.city,
      keywords: businessProfiles.keywords,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.orgId, ctx.orgId))
    .limit(1);

  const result = scoreTenderRelevance(tender, {
    sector: profile?.sector ?? null,
    city: profile?.city ?? null,
    keywords: profile?.keywords ?? [],
  });

  await db
    .insert(tenderMatches)
    .values({
      tenderId: tender.id,
      orgId: ctx.orgId,
      relevanceScore: result.score,
      eligibility: result.eligibility,
      reasons: result.reasons,
    })
    .onConflictDoUpdate({
      target: [tenderMatches.tenderId, tenderMatches.orgId],
      set: {
        relevanceScore: result.score,
        eligibility: result.eligibility,
        reasons: result.reasons,
        updatedAt: new Date(),
      },
    });

  return result;
}


const DEFAULT_CHECKLIST = [
  "Read the official notice and note every mandatory requirement",
  "Company registration certificate",
  "Valid tax clearance certificate",
  "Audited financial statements (as required by the notice)",
  "Technical proposal and methodology",
  "Priced bill of quantities / price schedule",
  "Bid security or tender guarantee",
  "Evidence of similar past experience",
];

export async function ensureChecklist(db: AppDb, ctx: OrgContext, tenderId: string) {
  if (!ctx.permissions.includes("tenders:write")) throw new ForbiddenError();
  const [tender] = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(
      and(
        eq(tenders.id, tenderId),
        or(eq(tenders.orgId, ctx.orgId), eq(tenders.provenance, "sample")),
      ),
    )
    .limit(1);
  if (!tender) throw new NotFoundError("Tender not found");

  const existing = await getChecklist(db, ctx, tenderId);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const [checklist] = await tx
      .insert(bidChecklists)
      .values({ orgId: ctx.orgId, tenderId, createdBy: ctx.actor.user.id })
      .returning({ id: bidChecklists.id, status: bidChecklists.status });
    if (!checklist) throw new AppError("Could not create checklist", 500);
    await tx.insert(bidChecklistItems).values(
      DEFAULT_CHECKLIST.map((label, index) => ({
        checklistId: checklist.id,
        label,
        sortOrder: index,
      })),
    );
    const items = await tx
      .select()
      .from(bidChecklistItems)
      .where(eq(bidChecklistItems.checklistId, checklist.id))
      .orderBy(bidChecklistItems.sortOrder);
    return { ...checklist, items };
  });
}

export async function getChecklist(db: AppDb, ctx: OrgContext, tenderId: string) {
  const [checklist] = await db
    .select()
    .from(bidChecklists)
    .where(and(eq(bidChecklists.tenderId, tenderId), eq(bidChecklists.orgId, ctx.orgId)))
    .limit(1);
  if (!checklist) return null;
  const items = await db
    .select()
    .from(bidChecklistItems)
    .where(eq(bidChecklistItems.checklistId, checklist.id))
    .orderBy(bidChecklistItems.sortOrder);
  return { ...checklist, items };
}

export async function toggleChecklistItem(
  db: AppDb,
  ctx: OrgContext,
  itemId: string,
  done: boolean,
): Promise<void> {
  if (!ctx.permissions.includes("tenders:write")) throw new ForbiddenError();
  const [row] = await db
    .select({
      itemId: bidChecklistItems.id,
      checklistId: bidChecklists.id,
    })
    .from(bidChecklistItems)
    .innerJoin(bidChecklists, eq(bidChecklists.id, bidChecklistItems.checklistId))
    .where(and(eq(bidChecklistItems.id, itemId), eq(bidChecklists.orgId, ctx.orgId)))
    .limit(1);
  if (!row) throw new NotFoundError("Checklist item not found");

  await db
    .update(bidChecklistItems)
    .set({ done, doneAt: done ? new Date() : null })
    .where(eq(bidChecklistItems.id, row.itemId));

  const items = await db
    .select()
    .from(bidChecklistItems)
    .where(eq(bidChecklistItems.checklistId, row.checklistId));

  const allRequiredDone = items.filter((item) => item.required).every((item) => item.done);
  await db
    .update(bidChecklists)
    .set({
      status: allRequiredDone ? "ready" : items.some((item) => item.done) ? "in_progress" : "draft",
      updatedAt: new Date(),
    })
    .where(eq(bidChecklists.id, row.checklistId));

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    action: "tender.checklist_updated",
    entityType: "bid_checklist",
    entityId: row.checklistId,
    metadata: { itemId: row.itemId, done },
  });
}

