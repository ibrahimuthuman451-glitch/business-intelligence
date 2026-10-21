import { and, count, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { memberships, mfaChallenges, mfaRecoveryCodes, users } from "@/db/schema";
import { recordAuditSafe } from "../audit";
import { revokeAllSessions } from "../auth";
import { AppError, ConflictError, ForbiddenError, ValidationError } from "../errors";
import { hashToken, randomToken } from "../ids";
import { verifyPassword } from "../password";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCode,
  hashRecoveryCode,
  mfaEncryptionConfigured,
} from "./crypto";
import { mfaRequiredForActor } from "./policy";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

export type MfaStatus = {
  enabled: boolean;
  enrolledAt: Date | null;
  recoveryCodesRemaining: number;
  requiredByPolicy: boolean;
  available: boolean;
};

export async function userRequiresMfa(db: AppDb, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return false;
  const roles = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
  return mfaRequiredForActor({
    isPlatformAdmin: user.isPlatformAdmin,
    roles: roles.map((row) => row.role),
  });
}

export async function getMfaStatus(db: AppDb, userId: string): Promise<MfaStatus> {
  const [user] = await db
    .select({ enabled: users.mfaEnabled, enrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new AppError("User not found", 404, "not_found");
  const [remaining] = await db
    .select({ total: count() })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), sql`${mfaRecoveryCodes.usedAt} is null`));
  return {
    enabled: user.enabled,
    enrolledAt: user.enrolledAt,
    recoveryCodesRemaining: Number(remaining?.total ?? 0),
    requiredByPolicy: await userRequiresMfa(db, userId),
    available: mfaEncryptionConfigured(),
  };
}

export async function startMfaEnrollment(
  db: AppDb,
  userId: string,
  options: { password?: string; trusted: boolean; ipAddress?: string | null },
): Promise<{ secret: string; uri: string }> {
  if (!mfaEncryptionConfigured()) {
    throw new AppError(
      "MFA is not configured on this server (MFA_ENCRYPTION_KEY missing)",
      503,
      "mfa_not_configured",
    );
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("User not found", 404, "not_found");
  if (user.mfaEnabled) throw new ConflictError("MFA is already enabled for this account");
  if (!options.trusted) {
    if (!options.password || !(await verifyPassword(user.passwordHash, options.password))) {
      throw new ValidationError("Current password is incorrect");
    }
  }

  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({
      mfaSecretEncrypted: encryptMfaSecret(secret),
      mfaEnabled: false,
      mfaEnrolledAt: null,
      mfaLastStep: 0,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await recordAuditSafe(db, {
    actorUserId: userId,
    actorEmail: user.email,
    action: "mfa.setup_started",
    entityType: "user",
    entityId: userId,
    ipAddress: options.ipAddress,
  });
  return { secret, uri: totpUri({ email: user.email, secret }) };
}

export async function confirmMfaEnrollment(
  db: AppDb,
  userId: string,
  code: string,
  meta: { ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.mfaSecretEncrypted) {
    return { ok: false, error: "Start MFA setup before confirming a code" };
  }
  if (user.mfaEnabled) return { ok: false, error: "MFA is already enabled" };
  const secret = decryptMfaSecret(user.mfaSecretEncrypted);
  const verification = verifyTotp(secret, code);
  if (!verification.valid || verification.counter === null) {
    return { ok: false, error: "That code is not valid. Check your authenticator's clock and try again." };
  }

  const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode());
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({
        mfaEnabled: true,
        mfaEnrolledAt: new Date(),
        mfaLastStep: verification.counter as number,
        mfaRecoveryUsedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), eq(users.mfaEnabled, false)))
      .returning({ id: users.id });
    if (!row) return false;
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.insert(mfaRecoveryCodes).values(
      recoveryCodes.map((value) => ({ userId, codeHash: hashRecoveryCode(value) })),
    );
    await recordAuditSafe(tx as unknown as AppDb, {
      actorUserId: userId,
      actorEmail: user.email,
      action: "mfa.enrolled",
      entityType: "user",
      entityId: userId,
      metadata: { recoveryCodes: recoveryCodes.length },
      ipAddress: meta.ipAddress,
    });
    return true;
  });

  if (!updated) return { ok: false, error: "MFA is already enabled" };
  return { ok: true, recoveryCodes };
}

export type SecondFactorResult = {
  ok: boolean;
  method?: "totp" | "recovery";
  reason?: "invalid" | "replay" | "not_enabled";
};

export async function verifySecondFactor(
  db: AppDb,
  userId: string,
  code: string,
  meta: { purpose: string; ipAddress?: string | null },
): Promise<SecondFactorResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) {
    return { ok: false, reason: "not_enabled" };
  }

  let secret: string;
  try {
    secret = decryptMfaSecret(user.mfaSecretEncrypted);
  } catch (error) {
    await recordAuditSafe(db, {
      actorUserId: userId,
      actorEmail: user.email,
      action: "mfa.secret_unreadable",
      ipAddress: meta.ipAddress,
    });
    throw error;
  }

  const totp = verifyTotp(secret, code);
  if (totp.valid && totp.counter !== null) {
    if (totp.counter <= user.mfaLastStep) {
      await recordAuditSafe(db, {
        actorUserId: userId,
        actorEmail: user.email,
        action: "mfa.replay_rejected",
        metadata: { purpose: meta.purpose },
        ipAddress: meta.ipAddress,
      });
      return { ok: false, reason: "replay" };
    }
    const [updated] = await db
      .update(users)
      .set({ mfaLastStep: totp.counter, updatedAt: new Date() })
      .where(and(eq(users.id, userId), sql`${users.mfaLastStep} < ${totp.counter}`))
      .returning({ id: users.id });
    if (!updated) {
      await recordAuditSafe(db, {
        actorUserId: userId,
        actorEmail: user.email,
        action: "mfa.replay_rejected",
        metadata: { purpose: meta.purpose },
        ipAddress: meta.ipAddress,
      });
      return { ok: false, reason: "replay" };
    }
    await recordAuditSafe(db, {
      actorUserId: userId,
      actorEmail: user.email,
      action: "mfa.verified",
      metadata: { purpose: meta.purpose, method: "totp" },
      ipAddress: meta.ipAddress,
    });
    return { ok: true, method: "totp" };
  }

  const normalized = code.trim();
  if (/^[A-Za-z0-9-]{8,14}$/.test(normalized)) {
    const hash = hashRecoveryCode(normalized);
    const consumed = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: mfaRecoveryCodes.id })
        .from(mfaRecoveryCodes)
        .where(
          and(
            eq(mfaRecoveryCodes.userId, userId),
            eq(mfaRecoveryCodes.codeHash, hash),
            sql`${mfaRecoveryCodes.usedAt} is null`,
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return false;
      await tx
        .update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(mfaRecoveryCodes.id, row.id));
      await tx.update(users).set({ mfaRecoveryUsedAt: new Date() }).where(eq(users.id, userId));
      await recordAuditSafe(tx as unknown as AppDb, {
        actorUserId: userId,
        actorEmail: user.email,
        action: "mfa.recovery_used",
        metadata: { purpose: meta.purpose },
        ipAddress: meta.ipAddress,
      });
      return true;
    });
    if (consumed) return { ok: true, method: "recovery" };
  }

  await recordAuditSafe(db, {
    actorUserId: userId,
    actorEmail: user.email,
    action: "mfa.failed",
    metadata: { purpose: meta.purpose },
    ipAddress: meta.ipAddress,
  });
  return { ok: false, reason: "invalid" };
}

export async function disableMfa(
  db: AppDb,
  userId: string,
  input: { password: string; code: string },
  meta: { ipAddress?: string | null } = {},
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError("User not found", 404, "not_found");
  if (!user.mfaEnabled) throw new ValidationError("MFA is not enabled");
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw new ValidationError("Current password is incorrect");
  }
  if (await userRequiresMfa(db, userId)) {
    throw new ForbiddenError("MFA is required for your role and cannot be disabled");
  }
  const verified = await verifySecondFactor(db, userId, input.code, {
    purpose: "disable_mfa",
    ipAddress: meta.ipAddress,
  });
  if (!verified.ok) throw new ValidationError("A valid authenticator or recovery code is required");

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaEnrolledAt: null,
        mfaLastStep: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await recordAuditSafe(tx as unknown as AppDb, {
      actorUserId: userId,
      actorEmail: user.email,
      action: "mfa.disabled",
      entityType: "user",
      entityId: userId,
      ipAddress: meta.ipAddress,
    });
  });
  await revokeAllSessions(db, userId);
}

export type ChallengePurpose = "login" | "enroll";

export async function createMfaChallenge(
  db: AppDb,
  input: {
    userId: string;
    purpose: ChallengePurpose;
    nextPath: string;
    ipAddress?: string | null;
    ttlSeconds?: number;
  },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 300) * 1000);
  const [row] = await db
    .insert(mfaChallenges)
    .values({
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashToken(token),
      nextPath: input.nextPath,
      expiresAt,
      ipAddress: input.ipAddress ?? null,
    })
    .returning({ id: mfaChallenges.id });
  if (!row) throw new AppError("Could not create MFA challenge", 500, "mfa_challenge_failed");
  return { id: row.id, token, expiresAt };
}

export type ActiveMfaChallenge = {
  id: string;
  userId: string;
  purpose: ChallengePurpose;
  nextPath: string;
  attempts: number;
  expiresAt: Date;
};

export async function findMfaChallenge(
  db: AppDb,
  token: string,
  purpose: ChallengePurpose,
): Promise<ActiveMfaChallenge | null> {
  const [row] = await db
    .select({
      id: mfaChallenges.id,
      userId: mfaChallenges.userId,
      purpose: mfaChallenges.purpose,
      nextPath: mfaChallenges.nextPath,
      attempts: mfaChallenges.attempts,
      expiresAt: mfaChallenges.expiresAt,
      consumedAt: mfaChallenges.consumedAt,
    })
    .from(mfaChallenges)
    .where(and(eq(mfaChallenges.tokenHash, hashToken(token)), eq(mfaChallenges.purpose, purpose)))
    .limit(1);
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    userId: row.userId,
    purpose: purpose,
    nextPath: row.nextPath,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
  };
}

export async function recordChallengeFailure(db: AppDb, challengeId: string): Promise<number> {
  const [row] = await db
    .update(mfaChallenges)
    .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
    .where(eq(mfaChallenges.id, challengeId))
    .returning({ attempts: mfaChallenges.attempts });
  const attempts = row?.attempts ?? 0;
  if (attempts >= 5) {
    await db.update(mfaChallenges).set({ consumedAt: new Date() }).where(eq(mfaChallenges.id, challengeId));
  }
  return attempts;
}

export async function consumeMfaChallenge(db: AppDb, challengeId: string): Promise<void> {
  await db
    .update(mfaChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(mfaChallenges.id, challengeId));
}

export async function pendingEnrollmentSecret(
  db: AppDb,
  userId: string,
): Promise<{ secret: string; uri: string } | null> {
  const [user] = await db
    .select({
      email: users.email,
      enabled: users.mfaEnabled,
      encrypted: users.mfaSecretEncrypted,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.enabled || !user.encrypted) return null;
  const secret = decryptMfaSecret(user.encrypted);
  return { secret, uri: totpUri({ email: user.email, secret }) };
}
