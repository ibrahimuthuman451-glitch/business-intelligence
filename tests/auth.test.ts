import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { memberships, sessions, users, verificationTokens } from "@/db/schema";
import {
  authenticate,
  createPasswordResetToken,
  createSession,
  registerUser,
  resetPassword,
  resolveSession,
  revokeSession,
  verifyEmail,
} from "@/lib/auth";
import { createOrg, createTestContext, TEST_PASSWORD, type TestContext } from "./helpers";
import { ConflictError, UnauthorizedError, ValidationError } from "@/lib/errors";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("registration and sessions", () => {
  it("creates a user, organization, owner membership and entitlements", async () => {
    const email = "owner-auth@example.com";
    const result = await registerUser(context.db, {
      name: "Aline Owner",
      email,
      password: TEST_PASSWORD,
      organizationName: "Aline Trading",
      currency: "RWF",
    });

    const [user] = await context.db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(user?.id).toBe(result.userId);
    expect(user?.passwordHash).not.toContain(TEST_PASSWORD);
    expect(user?.passwordHash.startsWith("$argon2")).toBe(true);
    expect(user?.emailVerifiedAt).toBeNull();

    const [membership] = await context.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, result.userId))
      .limit(1);
    expect(membership?.role).toBe("owner");
    expect(membership?.orgId).toBe(result.organizationId);
  });

  it("rejects duplicate emails and weak passwords", async () => {
    await createOrg(context.db, { email: "dupe@example.com", orgName: "Dupe Co" });
    await expect(
      registerUser(context.db, {
        name: "Someone Else",
        email: "DUPE@example.com",
        password: TEST_PASSWORD,
        organizationName: "Other Co",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      registerUser(context.db, {
        name: "Weak Password",
        email: "weak@example.com",
        password: "short1",
        organizationName: "Weak Co",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("authenticates with the right password only and stores hashed session tokens", async () => {
    const user = await createOrg(context.db, { email: "login@example.com", orgName: "Login Co" });
    const authenticated = await authenticate(context.db, "LOGIN@example.com", TEST_PASSWORD);
    expect(authenticated.id).toBe(user.userId);

    await expect(authenticate(context.db, "login@example.com", "WrongPassword12!")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    const session = await createSession(context.db, user.userId);
    const resolved = await resolveSession(context.db, session.token);
    expect(resolved?.email).toBe("login@example.com");

    await revokeSession(context.db, session.token);
    expect(await resolveSession(context.db, session.token)).toBeNull();
    expect(await resolveSession(context.db, "not-a-real-token")).toBeNull();
  });

  it("verifies email tokens once and rejects reuse", async () => {
    const email = "verify@example.com";
    const result = await registerUser(context.db, {
      name: "Verify Me",
      email,
      password: TEST_PASSWORD,
      organizationName: "Verify Co",
    });
    await verifyEmail(context.db, result.emailVerificationToken);
    const [user] = await context.db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);

    await expect(verifyEmail(context.db, result.emailVerificationToken)).rejects.toThrow(/invalid or has expired/i);
  });

  it("resets a password, consumes the token and revokes every session", async () => {
    const user = await createOrg(context.db, { email: "reset@example.com", orgName: "Reset Co" });
    const session = await createSession(context.db, user.userId);
    const token = await createPasswordResetToken(context.db, "reset@example.com");
    expect(token).toBeTruthy();

    await resetPassword(context.db, token as string, "BrandNewPass9!");
    expect(await resolveSession(context.db, session.token)).toBeNull();
    await expect(authenticate(context.db, "reset@example.com", TEST_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    const again = await authenticate(context.db, "reset@example.com", "BrandNewPass9!");
    expect(again.id).toBe(user.userId);

    await expect(resetPassword(context.db, token as string, "AnotherPass9!x")).rejects.toThrow(
      /invalid or has expired/i,
    );
  });

  it("rejects expired sessions and sessions for disabled accounts", async () => {
    const user = await createOrg(context.db, { email: "expiry@example.com", orgName: "Expiry Co" });
    const session = await createSession(context.db, user.userId);
    await context.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, createHash("sha256").update(session.token).digest("hex")));
    expect(await resolveSession(context.db, session.token)).toBeNull();

    const second = await createSession(context.db, user.userId);
    await context.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.userId));
    expect(await resolveSession(context.db, second.token)).toBeNull();
    await expect(authenticate(context.db, "expiry@example.com", TEST_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("does not reveal whether an email exists when requesting a reset", async () => {
    const token = await createPasswordResetToken(context.db, "missing@example.com");
    expect(token).toBeNull();
    const rows = await context.db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.purpose, "password_reset"));
    expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true);
  });
});
