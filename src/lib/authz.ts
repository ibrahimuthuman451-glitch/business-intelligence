import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { advisorAccess, memberships, organizations, users } from "@/db/schema";
import type { AuthenticatedUser } from "./auth";
import { ForbiddenError, UnauthorizedError } from "./errors";

export const PERMISSIONS = [
  "org:read",
  "org:manage",
  "finance:read",
  "finance:write",
  "documents:read",
  "documents:write",
  "documents:review",
  "team:manage",
  "billing:manage",
  "tenders:read",
  "tenders:write",
  "recon:read",
  "recon:write",
  "recon:review",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const OWNER: Permission[] = [...PERMISSIONS];

const STAFF: Permission[] = [
  "org:read",
  "finance:read",
  "finance:write",
  "documents:read",
  "documents:write",
  "tenders:read",
  "tenders:write",
  "recon:read",
  "recon:write",
  "recon:review",
  "audit:read",
];

const ADVISOR: Permission[] = [
  "org:read",
  "finance:read",
  "finance:write",
  "documents:read",
  "documents:write",
  "documents:review",
  "tenders:read",
  "recon:read",
  "recon:write",
  "recon:review",
  "audit:read",
];

const FIRM_ADMIN: Permission[] = [...ADVISOR, "team:manage"];

/** Platform administrators deliberately have NO implicit tenant data access. */
const PLATFORM_ADMIN: Permission[] = [];

const MATRIX: Record<string, Permission[]> = {
  owner: OWNER,
  staff: STAFF,
  advisor: ADVISOR,
  firm_admin: FIRM_ADMIN,
  platform_admin: PLATFORM_ADMIN,
};

export function permissionsFor(role: string): Permission[] {
  return MATRIX[role] ?? [];
}

export function can(role: string, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export type Actor = {
  user: AuthenticatedUser;
  memberships: {
    orgId: string;
    role: string;
    status: string;
    orgName: string;
    orgKind: string;
    orgPlan: string;
  }[];
};

export type OrgContext = {
  orgId: string;
  orgName: string;
  plan: string;
  role: string;
  permissions: Permission[];
  viaAdvisorAccess: boolean;
  actor: Actor;
};

export async function loadActor(db: AppDb, userId: string): Promise<Actor | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const rows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      status: memberships.status,
      orgName: organizations.name,
      orgKind: organizations.kind,
      orgPlan: organizations.plan,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));

  return { user, memberships: rows };
}

export async function authorizeOrg(
  db: AppDb,
  actor: Actor,
  orgId: string,
  permission: Permission,
): Promise<OrgContext> {
  const membership = actor.memberships.find((m) => m.orgId === orgId);
  if (membership && can(membership.role, permission)) {
    return {
      orgId,
      orgName: membership.orgName,
      plan: membership.orgPlan,
      role: membership.role,
      permissions: permissionsFor(membership.role),
      viaAdvisorAccess: false,
      actor,
    };
  }

  // Advisors must have an explicit, active client authorization.
  const [grant] = await db
    .select({ id: advisorAccess.id })
    .from(advisorAccess)
    .where(
      and(
        eq(advisorAccess.clientOrgId, orgId),
        eq(advisorAccess.advisorUserId, actor.user.id),
        eq(advisorAccess.status, "active"),
      ),
    )
    .limit(1);

  if (grant && can("advisor", permission)) {
    const [org] = await db
      .select({ name: organizations.name, plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new ForbiddenError();
    return {
      orgId,
      orgName: org.name,
      plan: org.plan,
      role: "advisor",
      permissions: permissionsFor("advisor"),
      viaAdvisorAccess: true,
      actor,
    };
  }

  throw new ForbiddenError();
}

export async function requireActor(db: AppDb, userId: string | undefined): Promise<Actor> {
  if (!userId) throw new UnauthorizedError();
  const actor = await loadActor(db, userId);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

/** Guards against IDOR: an entity fetched by id must belong to the authorized org. */
export function assertSameOrg(entityOrgId: string | null, authorizedOrgId: string): void {
  if (!entityOrgId || entityOrgId !== authorizedOrgId) throw new ForbiddenError();
}
