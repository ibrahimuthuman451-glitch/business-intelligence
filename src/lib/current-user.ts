import { and, eq } from "drizzle-orm";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { advisorAccess, organizations } from "@/db/schema";
import { resolveSession } from "./auth";
import {
  authorizeOrg,
  loadActor,
  type Actor,
  type OrgContext,
  type Permission,
} from "./authz";
import { readActiveOrgCookie, readSessionToken } from "./session-cookie";

export type AccessibleOrg = { id: string; name: string; kind: string; role: string };

export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  const db = getDb();
  const user = await resolveSession(db, token);
  if (!user) return null;
  return loadActor(db, user.id);
});

export async function requirePageActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  return actor;
}

export const listAccessibleOrgs = cache(async (actor: Actor): Promise<AccessibleOrg[]> => {
  const fromMembership: AccessibleOrg[] = actor.memberships.map((m) => ({
    id: m.orgId,
    name: m.orgName,
    kind: m.orgKind,
    role: m.role,
  }));

  const db = getDb();
  const grants = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      kind: organizations.kind,
    })
    .from(advisorAccess)
    .innerJoin(organizations, eq(organizations.id, advisorAccess.clientOrgId))
    .where(and(eq(advisorAccess.advisorUserId, actor.user.id), eq(advisorAccess.status, "active")));

  const seen = new Set(fromMembership.map((o) => o.id));
  for (const grant of grants) {
    if (!seen.has(grant.id)) {
      fromMembership.push({ ...grant, role: "advisor" });
      seen.add(grant.id);
    }
  }
  return fromMembership;
});

export async function resolveActiveOrg(actor: Actor): Promise<OrgContext | null> {
  const db = getDb();
  const orgs = await listAccessibleOrgs(actor);
  if (orgs.length === 0) return null;
  const preferred = await readActiveOrgCookie();
  const selected = orgs.find((o) => o.id === preferred) ?? orgs[0];
  if (!selected) return null;
  try {
    return await authorizeOrg(db, actor, selected.id, "org:read");
  } catch {
    const fallback = orgs.find((o) => o.id !== selected.id);
    if (!fallback) return null;
    return authorizeOrg(db, actor, fallback.id, "org:read");
  }
}

export type PageContext = { actor: Actor; org: OrgContext; orgs: AccessibleOrg[] };

export async function requirePageContext(permission: Permission = "org:read"): Promise<PageContext> {
  const actor = await requirePageActor();
  const db = getDb();
  const orgs = await listAccessibleOrgs(actor);
  const base = await resolveActiveOrg(actor);
  if (!base) redirect("/no-access");
  try {
    const org = await authorizeOrg(db, actor, base.orgId, permission);
    return { actor, org, orgs };
  } catch {
    redirect("/no-access?reason=forbidden");
  }
}
