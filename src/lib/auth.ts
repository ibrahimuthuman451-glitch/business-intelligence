import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import {
  auditEvents,
  businessProfiles,
  memberships,
  organizations,
  sessions,
  subscriptionEntitlements,
  users,
  verificationTokens,
} from "@/db/schema";
import { recordAuditSafe } from "./audit";
import { AppError, ConflictError, UnauthorizedError, ValidationError } from "./errors";
import { hashToken, normalizeEmail, randomToken, slugify } from "./ids";
import { fakeVerify, hashPassword, verifyPassword } from "./password";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
const MAX_FAILED_LOGINS = 8;
const FAILED_LOGIN_WINDOW_MINUTES = 10;

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  organizationKind?: "business" | "accounting_firm";
  countryCode?: string;
  currency?: string;
};

export type RegisterResult = {
  userId: string;
  organizationId: string;
  emailVerificationToken: string;
};

export type SessionResult = {
  token: string;
  expiresAt: Date;
  userId: string;
};

export type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function uniqueSlug(db: AppDb, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate =
      attempt === 0
        ? base
        : `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function registerUser(
  db: AppDb,
  input: RegisterInput,
  meta: RequestMeta = {},
): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  const organizationName = input.organizationName.trim();
  if (name.length < 2) throw new ValidationError("Enter your full name");
  if (organizationName.length < 2) throw new ValidationError("Enter your organization name");

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new ConflictError("An account with this email already exists");

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(db, organizationName);

  const result = await db.transaction(async (tx): Promise<RegisterResult> => {
    const [user] = await tx
      .insert(users)
      .values({ email, name, passwordHash })
      .returning({ id: users.id });
    if (!user) throw new AppError("Could not create account", 500);

    const [org] = await tx
      .insert(organizations)
      .values({
        name: organizationName,
        slug,
        kind: input.organizationKind ?? "business",
        countryCode: (input.countryCode ?? "RW").toUpperCase(),
        defaultCurrency: (input.currency ?? "RWF").toUpperCase(),
        createdBy: user.id,
      })
      .returning({ id: organizations.id, defaultCurrency: organizations.defaultCurrency });
    if (!org) throw new AppError("Could not create organization", 500);

    await tx.insert(memberships).values({
      orgId: org.id,
      userId: user.id,
      role: "owner",
      status: "active",
    });
    await tx.insert(businessProfiles).values({
      orgId: org.id,
      legalName: organizationName,
      currency: org.defaultCurrency,
    });
    await tx.insert(subscriptionEntitlements).values([
      { orgId: org.id, feature: "finance", enabled: true },
      { orgId: org.id, feature: "documents", enabled: true, limitValue: 200 },
      { orgId: org.id, feature: "tenders", enabled: true },
      { orgId: org.id, feature: "reconciliation", enabled: true },
      { orgId: org.id, feature: "advisor_access", enabled: true },
    ]);

    const rawToken = randomToken();
    await tx.insert(verificationTokens).values({
      userId: user.id,
      purpose: "email_verify",
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return { userId: user.id, organizationId: org.id, emailVerificationToken: rawToken };
  });

  await recordAuditSafe(db, {
    orgId: result.organizationId,
    actorUserId: result.userId,
    actorEmail: email,
    action: "auth.registered",
    entityType: "user",
    entityId: result.userId,
    ipAddress: meta.ipAddress,
  });

  return result;
}

export async function createSession(
  db: AppDb,
  userId: string,
  meta: RequestMeta = {},
): Promise<SessionResult> {
  const token = randomToken();
  const expiresAt = sessionExpiry();
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });
  return { token, expiresAt, userId };
}

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
  isPlatformAdmin: boolean;
};

export async function authenticate(
  db: AppDb,
  rawEmail: string,
  password: string,
  meta: RequestMeta = {},
): Promise<AuthenticatedUser> {
  const email = normalizeEmail(rawEmail);
  const since = new Date(Date.now() - FAILED_LOGIN_WINDOW_MINUTES * 60 * 1000);
  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "auth.login_failed"),
        eq(auditEvents.actorEmail, email),
        gte(auditEvents.createdAt, since),
      ),
    );

  if ((recent?.count ?? 0) >= MAX_FAILED_LOGINS) {
    throw new AppError(
      "Too many failed sign-in attempts. Try again in a few minutes.",
      429,
      "rate_limited",
    );
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    await fakeVerify(password);
    await recordAuditSafe(db, {
      actorEmail: email,
      action: "auth.login_failed",
      metadata: { reason: "unknown_account" },
      ipAddress: meta.ipAddress,
    });
    throw new UnauthorizedError("Email or password is incorrect");
  }
  if (user.disabledAt) throw new UnauthorizedError("Email or password is incorrect");

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await recordAuditSafe(db, {
      actorEmail: email,
      action: "auth.login_failed",
      metadata: { reason: "bad_password" },
      ipAddress: meta.ipAddress,
    });
    throw new UnauthorizedError("Email or password is incorrect");
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await recordAuditSafe(db, {
    actorUserId: user.id,
    actorEmail: email,
    action: "auth.login",
    ipAddress: meta.ipAddress,
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

export async function resolveSession(db: AppDb, token: string): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerifiedAt: users.emailVerifiedAt,
        isPlatformAdmin: users.isPlatformAdmin,
        disabledAt: users.disabledAt,
      },
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt || row.user.disabledAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    emailVerifiedAt: row.user.emailVerifiedAt,
    isPlatformAdmin: row.user.isPlatformAdmin,
  };
}

export async function revokeSession(db: AppDb, token: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessions(db: AppDb, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`));
}



export async function verifyEmail(db: AppDb, token: string): Promise<void> {
  const [row] = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, hashToken(token)),
        eq(verificationTokens.purpose, "email_verify"),
      ),
    )
    .limit(1);

  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new AppError("This verification link is invalid or has expired", 400, "invalid_token");
  }
  await db.transaction(async (tx) => {
    await tx.update(verificationTokens).set({ usedAt: new Date() }).where(eq(verificationTokens.id, row.id));
    await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
  });
  await recordAuditSafe(db, {
    actorUserId: row.userId,
    action: "auth.email_verified",
    entityType: "user",
    entityId: row.userId,
  });
}

/**
 * Creates a reset token when the account exists. Always resolves without
 * revealing whether the email is registered. The caller delivers the token.
 */
export async function createPasswordResetToken(db: AppDb, rawEmail: string): Promise<string | null> {
  const email = normalizeEmail(rawEmail);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) return null;

  const rawToken = randomToken();
  await db.insert(verificationTokens).values({
    userId: user.id,
    purpose: "password_reset",
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  await recordAuditSafe(db, {
    actorUserId: user.id,
    actorEmail: email,
    action: "auth.password_reset_requested",
  });
  return rawToken;
}

export async function resetPassword(db: AppDb, token: string, newPassword: string): Promise<void> {
  const [row] = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, hashToken(token)),
        eq(verificationTokens.purpose, "password_reset"),
      ),
    )
    .limit(1);

  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new AppError("This reset link is invalid or has expired", 400, "invalid_token");
  }
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(verificationTokens).set({ usedAt: new Date() }).where(eq(verificationTokens.id, row.id));
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, row.userId));
  });
  await revokeAllSessions(db, row.userId);
  await recordAuditSafe(db, {
    actorUserId: row.userId,
    action: "auth.password_reset_completed",
  });
}

export async function changePassword(
  db: AppDb,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new UnauthorizedError();
  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) throw new ValidationError("Current password is incorrect");
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeAllSessions(db, userId);
  await recordAuditSafe(db, { actorUserId: userId, action: "auth.password_changed" });
}
