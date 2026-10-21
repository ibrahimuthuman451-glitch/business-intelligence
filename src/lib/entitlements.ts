import { and, count, eq, ne, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  advisorAccess,
  documentRequests,
  documents,
  invitations,
  memberships,
  organizations,
  subscriptionEntitlements,
  tenderMatches,
} from "@/db/schema";
import { AppError, NotFoundError } from "./errors";

export type PlanId = "demo" | "free" | "pilot" | "pro";

export type PlanLimits = {
  organizationsPerUser: number;
  advisorClients: number;
  teamMembers: number;
  documentsCount: number;
  documentStorageBytes: number;
  savedTenders: number;
  advancedExports: boolean;
  aiCredits: number;
};

export const PLANS: Record<PlanId, PlanLimits> = {
  demo: {
    organizationsPerUser: 3,
    advisorClients: 50,
    teamMembers: 25,
    documentsCount: 1000,
    documentStorageBytes: 5 * 1024 * 1024 * 1024,
    savedTenders: 100,
    advancedExports: true,
    aiCredits: 0,
  },
  free: {
    organizationsPerUser: 1,
    advisorClients: 0,
    teamMembers: 2,
    documentsCount: 50,
    documentStorageBytes: 100 * 1024 * 1024,
    savedTenders: 3,
    advancedExports: false,
    aiCredits: 0,
  },
  pilot: {
    organizationsPerUser: 3,
    advisorClients: 25,
    teamMembers: 10,
    documentsCount: 1000,
    documentStorageBytes: 2 * 1024 * 1024 * 1024,
    savedTenders: 50,
    advancedExports: true,
    aiCredits: 0,
  },
  pro: {
    organizationsPerUser: 10,
    advisorClients: 200,
    teamMembers: 50,
    documentsCount: 10000,
    documentStorageBytes: 50 * 1024 * 1024 * 1024,
    savedTenders: 500,
    advancedExports: true,
    aiCredits: 0,
  },
};

export type Metric =
  | "organizations_per_user"
  | "advisor_clients"
  | "team_members"
  | "documents_count"
  | "document_storage_bytes"
  | "saved_tenders"
  | "advanced_exports"
  | "ai_credits";

const PLAN_FIELD: Record<Metric, keyof PlanLimits> = {
  organizations_per_user: "organizationsPerUser",
  advisor_clients: "advisorClients",
  team_members: "teamMembers",
  documents_count: "documentsCount",
  document_storage_bytes: "documentStorageBytes",
  saved_tenders: "savedTenders",
  advanced_exports: "advancedExports",
  ai_credits: "aiCredits",
};

export function planLimits(plan: string): PlanLimits {
  return PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
}

export async function orgPlan(db: AppDb, orgId: string): Promise<{ plan: PlanId; name: string }> {
  const [row] = await db
    .select({ plan: organizations.plan, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw new NotFoundError("Organization not found");
  return { plan: (row.plan in PLANS ? row.plan : "free") as PlanId, name: row.name };
}

/** Plan default, overridable by a subscription_entitlements row. */
export async function resolveLimit(
  db: AppDb,
  orgId: string,
  metric: Metric,
): Promise<{ enabled: boolean; limit: number | boolean }> {
  const { plan } = await orgPlan(db, orgId);
  const fallback = planLimits(plan)[PLAN_FIELD[metric]];
  const [override] = await db
    .select({ enabled: subscriptionEntitlements.enabled, limitValue: subscriptionEntitlements.limitValue })
    .from(subscriptionEntitlements)
    .where(
      and(
        eq(subscriptionEntitlements.orgId, orgId),
        eq(subscriptionEntitlements.feature, metric),
      ),
    )
    .limit(1);
  if (!override) return { enabled: true, limit: fallback };
  if (!override.enabled) return { enabled: false, limit: typeof fallback === "boolean" ? false : 0 };
  if (typeof fallback === "boolean") return { enabled: Boolean(override.limitValue ?? 1), limit: Boolean(override.limitValue ?? 1) };
  return { enabled: true, limit: override.limitValue ?? (fallback as number) };
}

export async function currentUsage(db: AppDb, orgId: string, metric: Metric): Promise<number> {
  switch (metric) {
    case "team_members": {
      const [row] = await db
        .select({ total: count() })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")));
      return Number(row?.total ?? 0);
    }
    case "documents_count": {
      const [row] = await db
        .select({ total: count() })
        .from(documents)
        .where(eq(documents.orgId, orgId));
      return Number(row?.total ?? 0);
    }
    case "document_storage_bytes": {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${documents.sizeBytes}), 0)::text` })
        .from(documents)
        .where(eq(documents.orgId, orgId));
      return Number(row?.total ?? 0);
    }
    case "saved_tenders": {
      const [row] = await db
        .select({ total: count() })
        .from(tenderMatches)
        .where(and(eq(tenderMatches.orgId, orgId), eq(tenderMatches.saved, true)));
      return Number(row?.total ?? 0);
    }
    case "advisor_clients": {
      const [row] = await db
        .select({ total: sql<number>`count(distinct ${advisorAccess.clientOrgId})::int` })
        .from(advisorAccess)
        .where(and(eq(advisorAccess.firmOrgId, orgId), ne(advisorAccess.status, "revoked")));
      return Number(row?.total ?? 0);
    }
    case "organizations_per_user": {
      return 0;
    }
    case "advanced_exports":
    case "ai_credits":
      return 0;
    default:
      return 0;
  }
}

export async function pendingSeats(db: AppDb, orgId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(invitations)
    .where(and(eq(invitations.orgId, orgId), sql`${invitations.acceptedAt} is null`, sql`${invitations.revokedAt} is null`));
  return Number(row?.total ?? 0);
}

export function entitlementError(metric: Metric, limit: number | boolean): AppError {
  const message =
    metric === "advanced_exports"
      ? "Advanced exports are not included in this plan. Ask the owner to upgrade."
      : `Plan limit reached for ${metric.replace(/_/g, " ")} (${String(limit)}). Remove records or upgrade the plan.`;
  return new AppError(message, 402, "entitlement_limit");
}

export async function assertEntitlement(
  db: AppDb,
  orgId: string,
  metric: Metric,
  delta = 1,
): Promise<void> {
  const { enabled, limit } = await resolveLimit(db, orgId, metric);
  if (!enabled) throw entitlementError(metric, limit);
  if (metric === "advanced_exports") {
    if (limit !== true) throw entitlementError(metric, limit);
    return;
  }
  const used = await currentUsage(db, orgId, metric);
  if (used + delta > Number(limit)) throw entitlementError(metric, limit);
}

/**
 * Serialises quota checks for an organization by locking its row. Quota checks
 * and the corresponding insert must run inside this transaction, otherwise two
 * concurrent requests could both pass the check.
 */
export async function withOrgQuota<T>(
  db: AppDb,
  orgId: string,
  work: (tx: AppDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (!org) throw new NotFoundError("Organization not found");
    return work(tx as unknown as AppDb);
  });
}

export async function assertTeamSeat(db: AppDb, orgId: string, delta = 1): Promise<void> {
  const { enabled, limit } = await resolveLimit(db, orgId, "team_members");
  if (!enabled) throw entitlementError("team_members", limit);
  const used = (await currentUsage(db, orgId, "team_members")) + (await pendingSeats(db, orgId));
  if (used + delta > Number(limit)) throw entitlementError("team_members", limit);
}

export async function assertCanCreateOrganization(db: AppDb, userId: string): Promise<void> {
  const rows = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.role, "owner"),
        eq(memberships.status, "active"),
      ),
    );
  const owned = rows.length;
  let allowed = PLANS.free.organizationsPerUser;
  if (rows[0]) {
    const { plan } = await orgPlan(db, rows[0].orgId);
    allowed = planLimits(plan).organizationsPerUser;
  }
  if (owned >= allowed) {
    throw new AppError(
      `Your plan allows ${allowed} organization${allowed === 1 ? "" : "s"}. Upgrade to create another.`,
      402,
      "entitlement_limit",
    );
  }
}

export type EntitlementSnapshot = {
  plan: PlanId;
  limits: PlanLimits;
  usage: {
    teamMembers: number;
    pendingInvitations: number;
    documents: number;
    storageBytes: number;
    savedTenders: number;
    advisorClients: number;
    openDocumentRequests: number;
  };
};

export async function entitlementSnapshot(db: AppDb, orgId: string): Promise<EntitlementSnapshot> {
  const { plan } = await orgPlan(db, orgId);
  const [team, pending, docs, storage, saved, clients, requests] = await Promise.all([
    currentUsage(db, orgId, "team_members"),
    pendingSeats(db, orgId),
    currentUsage(db, orgId, "documents_count"),
    currentUsage(db, orgId, "document_storage_bytes"),
    currentUsage(db, orgId, "saved_tenders"),
    currentUsage(db, orgId, "advisor_clients"),
    db
      .select({ total: count() })
      .from(documentRequests)
      .where(and(eq(documentRequests.orgId, orgId), eq(documentRequests.status, "open"))),
  ]);
  return {
    plan,
    limits: planLimits(plan),
    usage: {
      teamMembers: team,
      pendingInvitations: pending,
      documents: docs,
      storageBytes: storage,
      savedTenders: saved,
      advisorClients: clients,
      openDocumentRequests: Number(requests[0]?.total ?? 0),
    },
  };
}
