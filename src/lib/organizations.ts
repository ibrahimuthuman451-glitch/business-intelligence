import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { businessProfiles, memberships, organizations, users } from "@/db/schema";
import { recordAuditSafe } from "./audit";
import { AppError, ValidationError } from "./errors";
import { assertCanCreateOrganization } from "./entitlements";
import { randomToken, slugify } from "./ids";

export async function createOrganizationForUser(
  db: AppDb,
  userId: string,
  input: { name: string; kind: "business" | "accounting_firm"; currency?: string },
): Promise<{ orgId: string }> {
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Enter an organization name");
  await assertCanCreateOrganization(db, userId);

  const result = await db.transaction(async (tx) => {
    // Lock the user row so concurrent create-organization requests cannot both
    // pass the per-user plan limit.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await assertCanCreateOrganization(tx as unknown as AppDb, userId);

    const slugBase = slugify(name);
    let slug = slugBase;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [taken] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      if (!taken) break;
      slug = `${slugBase}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4)}`;
    }

    const [owner] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner"), eq(memberships.status, "active")))
      .limit(1);
    const plan = owner ? "free" : "free";
    const currency = (input.currency ?? "RWF").toUpperCase();

    const [org] = await tx
      .insert(organizations)
      .values({ name, slug, kind: input.kind, defaultCurrency: currency, plan, createdBy: userId })
      .returning({ id: organizations.id });
    if (!org) throw new AppError("Could not create organization", 500);
    await tx.insert(memberships).values({ orgId: org.id, userId, role: "owner", status: "active" });
    await tx.insert(businessProfiles).values({ orgId: org.id, legalName: name, currency });
    return { orgId: org.id };
  });

  await recordAuditSafe(db, {
    orgId: result.orgId,
    actorUserId: userId,
    action: "organization.created",
    entityType: "organization",
    entityId: result.orgId,
    metadata: { kind: input.kind },
  });
  return result;
}

export function newOrganizationPlan(): "free" {
  return "free";
}

