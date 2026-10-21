import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { advisorAccess, invitations, memberships, organizations, users } from "@/db/schema";
import { recordAuditSafe } from "./audit";
import type { OrgContext } from "./authz";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { consumeRateLimit } from "./rate-limit";
import { hashToken, normalizeEmail, randomToken } from "./ids";
import { hashPassword } from "./password";
import { assertEntitlement, assertTeamSeat, withOrgQuota } from "./entitlements";

const INVITE_TTL_DAYS = 7;
export const INVITABLE_ROLES = ["staff", "advisor", "firm_admin"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

function inviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function createMemberInvitation(
  db: AppDb,
  ctx: OrgContext,
  input: { email: string; role: InvitableRole },
  meta: { ipAddress?: string | null } = {},
): Promise<{ id: string; token: string }> {
  if (!ctx.permissions.includes("team:manage")) throw new ForbiddenError();
  if (!ctx.actor.user.emailVerifiedAt) {
    throw new ForbiddenError("Verify your email address before inviting people");
  }
  const rate = await consumeRateLimit(db, {
    bucket: "team_invitations",
    key: ctx.orgId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rate.allowed) {
    throw new AppError("Too many invitations sent. Try again later.", 429, "rate_limited");
  }
  if (!INVITABLE_ROLES.includes(input.role)) throw new ValidationError("Invalid role");
  if (!ctx.permissions.includes("billing:manage") && input.role !== "advisor") {
    throw new ForbiddenError("Only an owner can invite staff");
  }
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("Enter a valid email");

  const [existingMember] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(users.email, email)))
    .limit(1);
  if (existingMember) throw new ConflictError("That person is already a member");

  const token = randomToken();
  const row = await withOrgQuota(db, ctx.orgId, async (tx) => {
    await assertTeamSeat(tx, ctx.orgId, 1);
    const [inserted] = await tx
      .insert(invitations)
      .values({
        orgId: ctx.orgId,
        email,
        role: input.role,
        kind: "member",
        tokenHash: hashToken(token),
        invitedBy: ctx.actor.user.id,
        expiresAt: inviteExpiry(),
      })
      .returning({ id: invitations.id });
    if (!inserted) throw new Error("Could not create invitation");
    return inserted;
  });

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: "team.invitation_created",
    entityType: "invitation",
    entityId: row.id,
    metadata: { email, role: input.role },
    ipAddress: meta.ipAddress,
  });
  return { id: row.id, token };
}

/**
 * Grants an advisor explicit, client-authorized access to this organization.
 * The grant stays pending until the advisor accepts the invitation.
 */
export async function grantAdvisorAccess(
  db: AppDb,
  ctx: OrgContext,
  input: { advisorEmail: string; firmOrgId?: string | null },
  meta: { ipAddress?: string | null } = {},
): Promise<{ id: string; invitationId: string; token: string }> {
  if (!ctx.permissions.includes("team:manage")) throw new ForbiddenError();
  if (!ctx.actor.user.emailVerifiedAt) {
    throw new ForbiddenError("Verify your email address before authorizing an advisor");
  }
  const rate = await consumeRateLimit(db, {
    bucket: "advisor_grants",
    key: ctx.orgId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rate.allowed) {
    throw new AppError("Too many advisor invitations sent. Try again later.", 429, "rate_limited");
  }
  const advisorEmail = normalizeEmail(input.advisorEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(advisorEmail)) {
    throw new ValidationError("Enter a valid advisor email");
  }

  const firmOrgId = input.firmOrgId ?? null;
  if (firmOrgId) {
    const [firm] = await db
      .select({ id: organizations.id, kind: organizations.kind })
      .from(organizations)
      .where(eq(organizations.id, firmOrgId))
      .limit(1);
    if (!firm || firm.kind !== "accounting_firm") {
      throw new ValidationError("Unknown accounting firm");
    }
  }

  const token = randomToken();
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: advisorAccess.id, status: advisorAccess.status })
      .from(advisorAccess)
      .where(
        and(eq(advisorAccess.clientOrgId, ctx.orgId), eq(advisorAccess.advisorEmail, advisorEmail)),
      )
      .limit(1);
    if (existing && existing.status !== "revoked") {
      throw new ConflictError("This advisor already has access or a pending invitation");
    }

    if (firmOrgId) {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, firmOrgId))
        .for("update");
      await assertEntitlement(tx as unknown as AppDb, firmOrgId, "advisor_clients", 1);
    }

    const grantValues = {
      status: "pending" as const,
      firmOrgId,
      grantedBy: ctx.actor.user.id,
      grantedAt: null,
      revokedAt: null,
      revokedBy: null,
    };

    const [grant] = existing
      ? await tx
          .update(advisorAccess)
          .set(grantValues)
          .where(eq(advisorAccess.id, existing.id))
          .returning({ id: advisorAccess.id })
      : await tx
          .insert(advisorAccess)
          .values({
            clientOrgId: ctx.orgId,
            advisorEmail,
            firmOrgId,
            status: "pending",
            grantedBy: ctx.actor.user.id,
          })
          .returning({ id: advisorAccess.id });
    if (!grant) throw new Error("Could not create access grant");

    const [invitation] = await tx
      .insert(invitations)
      .values({
        orgId: ctx.orgId,
        email: advisorEmail,
        role: "advisor",
        kind: "advisor",
        tokenHash: hashToken(token),
        invitedBy: ctx.actor.user.id,
        expiresAt: inviteExpiry(),
      })
      .returning({ id: invitations.id });
    if (!invitation) throw new Error("Could not create invitation");
    return { id: grant.id, invitationId: invitation.id };
  });

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: "advisor.access_granted",
    entityType: "advisor_access",
    entityId: result.id,
    metadata: { advisorEmail, firmOrgId },
    ipAddress: meta.ipAddress,
  });
  return { ...result, token };
}

export type InvitationLookup = {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: string;
  kind: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export async function findInvitationByToken(
  db: AppDb,
  token: string,
): Promise<InvitationLookup | null> {
  const [row] = await db
    .select({
      id: invitations.id,
      orgId: invitations.orgId,
      orgName: organizations.name,
      email: invitations.email,
      role: invitations.role,
      kind: invitations.kind,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

export function invitationProblem(invite: InvitationLookup | null): string | null {
  if (!invite) return "This invitation link is invalid";
  if (invite.revokedAt) return "This invitation was revoked";
  if (invite.acceptedAt) return "This invitation has already been accepted";
  if (invite.expiresAt.getTime() <= Date.now()) return "This invitation has expired";
  return null;
}

async function applyInvitation(
  tx: AppDb,
  invite: InvitationLookup,
  userId: string,
): Promise<void> {
  // Advisor invitations authorize advisor access only. They must never create
  // a membership, otherwise revoking the grant would leave access behind.
  if (invite.kind === "member") {
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, userId)))
      .limit(1);

    if (membership) {
      await tx
        .update(memberships)
        .set({
          role: invite.role as "staff" | "advisor" | "firm_admin",
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(memberships.id, membership.id));
    } else {
      await tx.insert(memberships).values({
        orgId: invite.orgId,
        userId,
        role: invite.role as "staff" | "advisor" | "firm_admin",
        status: "active",
      });
    }
  }

  if (invite.kind === "advisor") {
    const [grant] = await tx
      .select({ id: advisorAccess.id })
      .from(advisorAccess)
      .where(
        and(
          eq(advisorAccess.clientOrgId, invite.orgId),
          eq(advisorAccess.advisorEmail, invite.email),
        ),
      )
      .limit(1);
    if (grant) {
      await tx
        .update(advisorAccess)
        .set({ advisorUserId: userId, status: "active", grantedAt: new Date(), revokedAt: null })
        .where(eq(advisorAccess.id, grant.id));
    } else {
      await tx.insert(advisorAccess).values({
        clientOrgId: invite.orgId,
        advisorEmail: invite.email,
        advisorUserId: userId,
        status: "active",
        grantedBy: userId,
        grantedAt: new Date(),
      });
    }
  }

  await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));

  await recordAuditSafe(tx as unknown as AppDb, {
    orgId: invite.orgId,
    actorUserId: userId,
    action: "team.invitation_accepted",
    entityType: "invitation",
    entityId: invite.id,
    metadata: { role: invite.role, kind: invite.kind },
  });
}

export async function acceptInvitationForUser(
  db: AppDb,
  token: string,
  userId: string,
): Promise<{ orgId: string }> {
  const invite = await findInvitationByToken(db, token);
  const problem = invitationProblem(invite);
  if (!invite || problem) throw new ValidationError(problem ?? "Invalid invitation");

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new NotFoundError("User not found");
  if (normalizeEmail(user.email) !== invite.email) {
    throw new ForbiddenError("This invitation was issued to a different email address");
  }

  await withOrgQuota(db, invite.orgId, async (tx) => {
    if (invite.kind === "member") await assertTeamSeat(tx, invite.orgId, 0);
    await applyInvitation(tx, invite, userId);
  });
  return { orgId: invite.orgId };
}

export async function registerInvitedUser(
  db: AppDb,
  token: string,
  input: { name: string; password: string },
): Promise<{ userId: string; orgId: string }> {
  const invite = await findInvitationByToken(db, token);
  const problem = invitationProblem(invite);
  if (!invite || problem) throw new ValidationError(problem ?? "Invalid invitation");
  if (input.name.trim().length < 2) throw new ValidationError("Enter your full name");

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, invite.email))
    .limit(1);
  if (existing) {
    throw new ConflictError("An account already exists. Sign in to accept this invitation.");
  }

  // Receiving the invitation proves control of the mailbox, so mark it verified.
  const passwordHash = await hashPassword(input.password);
  return withOrgQuota(db, invite.orgId, async (tx) => {
    if (invite.kind === "member") await assertTeamSeat(tx, invite.orgId, 0);
    const [user] = await tx
      .insert(users)
      .values({
        email: invite.email,
        name: input.name.trim(),
        passwordHash,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("Could not create account");
    await applyInvitation(tx, invite, user.id);
    return { userId: user.id, orgId: invite.orgId };
  });
}

export type TeamMember = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  emailVerifiedAt: Date | null;
};

export async function listTeam(
  db: AppDb,
  orgId: string,
): Promise<{
  members: TeamMember[];
  pendingInvitations: { id: string; email: string; role: string; kind: string; expiresAt: Date }[];
  advisorGrants: {
    id: string;
    advisorEmail: string;
    status: string;
    firmOrgName: string | null;
    grantedAt: Date | null;
  }[];
}> {
  const members = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId));

  const pendingInvitations = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      kind: invitations.kind,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    );

  const advisorGrants = await db
    .select({
      id: advisorAccess.id,
      advisorEmail: advisorAccess.advisorEmail,
      status: advisorAccess.status,
      firmOrgName: organizations.name,
      grantedAt: advisorAccess.grantedAt,
    })
    .from(advisorAccess)
    .leftJoin(organizations, eq(organizations.id, advisorAccess.firmOrgId))
    .where(eq(advisorAccess.clientOrgId, orgId));

  return { members, pendingInvitations, advisorGrants };
}

export async function revokeAdvisorAccess(
  db: AppDb,
  ctx: OrgContext,
  accessId: string,
): Promise<void> {
  if (!ctx.permissions.includes("team:manage")) throw new ForbiddenError();
  const [grant] = await db
    .select()
    .from(advisorAccess)
    .where(and(eq(advisorAccess.id, accessId), eq(advisorAccess.clientOrgId, ctx.orgId)))
    .limit(1);
  if (!grant) throw new NotFoundError("Advisor access not found");

  await db
    .update(advisorAccess)
    .set({ status: "revoked", revokedAt: new Date(), revokedBy: ctx.actor.user.id })
    .where(eq(advisorAccess.id, grant.id));

  await recordAuditSafe(db, {
    orgId: ctx.orgId,
    actorUserId: ctx.actor.user.id,
    actorEmail: ctx.actor.user.email,
    action: "advisor.access_revoked",
    entityType: "advisor_access",
    entityId: grant.id,
    metadata: { advisorEmail: grant.advisorEmail },
  });
}


