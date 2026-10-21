import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { mfaChallenges, mfaRecoveryCodes, users } from "@/db/schema";
import { createOrg, createTestContext, reloadActor, TEST_PASSWORD, type TestContext } from "./helpers";
import { createSession, resolveSession } from "@/lib/auth";
import { authorizeOrg } from "@/lib/authz";
import { decryptMfaSecret } from "@/lib/mfa/crypto";
import { mfaRequiredRoles } from "@/lib/mfa/policy";
import {
  confirmMfaEnrollment,
  createMfaChallenge,
  disableMfa,
  findMfaChallenge,
  getMfaStatus,
  recordChallengeFailure,
  startMfaEnrollment,
  userRequiresMfa,
  verifySecondFactor,
} from "@/lib/mfa/service";
import { hotp, totpUri, verifyTotp } from "@/lib/mfa/totp";

let context: TestContext;
const KEY = randomBytes(32).toString("base64");

beforeAll(async () => {
  process.env.MFA_ENCRYPTION_KEY = KEY;
  context = await createTestContext();
});

afterEach(() => {
  process.env.MFA_ENCRYPTION_KEY = KEY;
  process.env.MFA_REQUIRED_FOR = "platform_admin";
});

afterAll(async () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  delete process.env.MFA_REQUIRED_FOR;
  await context.cleanup();
});

function counter(offset = 0): number {
  return Math.floor(Date.now() / 1000 / 30) + offset;
}

describe("TOTP primitives", () => {
  it("matches the RFC 6238 SHA-1 vector and builds an otpauth URI", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    // RFC vector at T=59 returns 94287082 for 8 digits; our 6-digit suffix is 287082.
    expect(hotp(secret, 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", { now: new Date(59_000) }).valid).toBe(true);
    expect(verifyTotp(secret, "000000", { now: new Date(59_000) }).valid).toBe(false);
    expect(totpUri({ email: "owner@example.com", secret })).toContain("otpauth://totp/");
    expect(totpUri({ email: "owner@example.com", secret })).toContain("issuer=Ledgerline");
  });
});

describe("MFA enrollment and login", () => {
  it("stores the secret encrypted, returns one-time recovery codes, and verifies login", async () => {
    const org = await createOrg(context.db, { email: "mfa-owner@example.com", orgName: "MFA Owner" });
    await expect(
      startMfaEnrollment(context.db, org.userId, { password: "WrongPassword9!", trusted: false }),
    ).rejects.toThrow(/password is incorrect/i);

    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    expect(started.secret.length).toBeGreaterThan(20);

    const [stored] = await context.db.select().from(users).where(eq(users.id, org.userId));
    expect(stored?.mfaSecretEncrypted).not.toContain(started.secret);
    expect(stored?.mfaSecretEncrypted?.startsWith("v1:")).toBe(true);
    expect(decryptMfaSecret(stored!.mfaSecretEncrypted!)).toBe(started.secret);

    const confirmCode = hotp(started.secret, counter(-1));
    const confirmed = await confirmMfaEnrollment(context.db, org.userId, confirmCode);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const hashes = await context.db
      .select({ hash: mfaRecoveryCodes.codeHash })
      .from(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, org.userId));
    expect(hashes).toHaveLength(10);
    for (const code of confirmed.recoveryCodes!) {
      expect(hashes.some((row) => row.hash === code)).toBe(false);
    }

    const status = await getMfaStatus(context.db, org.userId);
    expect(status.enabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);

    const login = await verifySecondFactor(context.db, org.userId, hotp(started.secret, counter(0)), {
      purpose: "login",
    });
    expect(login).toMatchObject({ ok: true, method: "totp" });
  });

  it("rejects invalid codes and replays of an already used time step", async () => {
    const org = await createOrg(context.db, { email: "mfa-replay@example.com", orgName: "MFA Replay" });
    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));

    const invalid = await verifySecondFactor(context.db, org.userId, "000000", { purpose: "login" });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });

    const code = hotp(started.secret, counter(0));
    const first = await verifySecondFactor(context.db, org.userId, code, { purpose: "login" });
    expect(first.ok).toBe(true);
    const replay = await verifySecondFactor(context.db, org.userId, code, { purpose: "login" });
    expect(replay).toMatchObject({ ok: false, reason: "replay" });
  });

  it("consumes recovery codes exactly once", async () => {
    const org = await createOrg(context.db, { email: "mfa-recovery@example.com", orgName: "MFA Recovery" });
    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    const confirmed = await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));
    const recovery = confirmed.recoveryCodes![0]!;

    const first = await verifySecondFactor(context.db, org.userId, recovery, { purpose: "login" });
    expect(first).toMatchObject({ ok: true, method: "recovery" });
    const second = await verifySecondFactor(context.db, org.userId, recovery, { purpose: "login" });
    expect(second.ok).toBe(false);

    const status = await getMfaStatus(context.db, org.userId);
    expect(status.recoveryCodesRemaining).toBe(9);
  });

  it("disables MFA only with password and a valid code, then revokes sessions", async () => {
    const org = await createOrg(context.db, { email: "mfa-disable@example.com", orgName: "MFA Disable" });
    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));
    await verifySecondFactor(context.db, org.userId, hotp(started.secret, counter(0)), { purpose: "login" });
    const session = await createSession(context.db, org.userId);

    await expect(
      disableMfa(context.db, org.userId, { password: "WrongPassword9!", code: "000000" }),
    ).rejects.toThrow(/password is incorrect/i);
    await expect(
      disableMfa(context.db, org.userId, { password: TEST_PASSWORD, code: "000000" }),
    ).rejects.toThrow(/valid authenticator/i);

    await disableMfa(context.db, org.userId, {
      password: TEST_PASSWORD,
      code: hotp(started.secret, counter(1)),
    });
    const status = await getMfaStatus(context.db, org.userId);
    expect(status.enabled).toBe(false);
    expect(await resolveSession(context.db, session.token)).toBeNull();
  });

  it("refuses to disable MFA required by policy", async () => {
    const org = await createOrg(context.db, { email: "mfa-policy@example.com", orgName: "MFA Policy" });
    process.env.MFA_REQUIRED_FOR = "owner";
    expect(await userRequiresMfa(context.db, org.userId)).toBe(true);
    expect(mfaRequiredRoles().has("owner")).toBe(true);

    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));
    await expect(
      disableMfa(context.db, org.userId, {
        password: TEST_PASSWORD,
        code: hotp(started.secret, counter(0)),
      }),
    ).rejects.toThrow(/required for your role/i);
  });

  it("blocks organization access for a privileged actor who has not enrolled", async () => {
    const org = await createOrg(context.db, { email: "mfa-gate@example.com", orgName: "MFA Gate" });
    process.env.MFA_REQUIRED_FOR = "owner";
    const actor = await reloadActor(context.db, org.userId);
    expect(actor.mfaRequired).toBe(true);
    expect(actor.user.mfaEnabled).toBe(false);
    await expect(authorizeOrg(context.db, actor, org.orgId, "finance:read")).rejects.toThrow(
      /multi-factor/i,
    );
  });

  it("fails closed when the encryption key is missing or the stored secret is tampered with", async () => {
    const org = await createOrg(context.db, { email: "mfa-key@example.com", orgName: "MFA Key" });
    delete process.env.MFA_ENCRYPTION_KEY;
    await expect(
      startMfaEnrollment(context.db, org.userId, { password: TEST_PASSWORD, trusted: false }),
    ).rejects.toMatchObject({ code: "mfa_not_configured" });

    process.env.MFA_ENCRYPTION_KEY = KEY;
    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));
    await context.db
      .update(users)
      .set({ mfaSecretEncrypted: "v1:bad:bad:bad" })
      .where(eq(users.id, org.userId));
    await expect(
      verifySecondFactor(context.db, org.userId, "123456", { purpose: "login" }),
    ).rejects.toMatchObject({ code: "mfa_secret_invalid" });
  });

  it("limits challenge attempts and expires challenges", async () => {
    const org = await createOrg(context.db, { email: "mfa-challenge@example.com", orgName: "MFA Challenge" });
    const challenge = await createMfaChallenge(context.db, {
      userId: org.userId,
      purpose: "login",
      nextPath: "/app/dashboard",
    });
    expect(await findMfaChallenge(context.db, challenge.token, "login")).not.toBeNull();
    for (let attempt = 0; attempt < 4; attempt += 1) await recordChallengeFailure(context.db, challenge.id);
    expect(await findMfaChallenge(context.db, challenge.token, "login")).not.toBeNull();
    await recordChallengeFailure(context.db, challenge.id);
    expect(await findMfaChallenge(context.db, challenge.token, "login")).toBeNull();

    const expired = await createMfaChallenge(context.db, {
      userId: org.userId,
      purpose: "login",
      nextPath: "/app/dashboard",
    });
    await context.db
      .update(mfaChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mfaChallenges.id, expired.id));
    expect(await findMfaChallenge(context.db, expired.token, "login")).toBeNull();
  });

  it("does not write secrets or recovery codes into audit metadata", async () => {
    const org = await createOrg(context.db, { email: "mfa-audit@example.com", orgName: "MFA Audit" });
    const started = await startMfaEnrollment(context.db, org.userId, {
      password: TEST_PASSWORD,
      trusted: false,
    });
    const confirmed = await confirmMfaEnrollment(context.db, org.userId, hotp(started.secret, counter(-1)));
    const { auditEvents } = await import("@/db/schema");
    const events = await context.db
      .select({ metadata: auditEvents.metadata, action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, org.userId));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(started.secret);
    for (const code of confirmed.recoveryCodes!) expect(serialized).not.toContain(code);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["mfa.setup_started", "mfa.enrolled"]),
    );
  });
});
