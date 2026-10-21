"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { createSession, revokeOtherSessions } from "@/lib/auth";
import { getCurrentActor } from "@/lib/current-user";
import { consumeRateLimit } from "@/lib/rate-limit";
import { describeError, requestMeta, safeNextPath } from "@/lib/request";
import { logServerError } from "@/lib/logger";
import {
  clearMfaChallengeCookie,
  clearMfaEnrollCookie,
  readMfaChallengeCookie,
  readMfaEnrollCookie,
  readSessionToken,
  setSessionCookie,
} from "@/lib/session-cookie";
import { getMfaSetupContext } from "@/lib/mfa/setup-context";
import {
  confirmMfaEnrollment,
  consumeMfaChallenge,
  disableMfa,
  findMfaChallenge,
  recordChallengeFailure,
  startMfaEnrollment,
  verifySecondFactor,
} from "@/lib/mfa/service";

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fail(path: string, error: unknown): never {
  const message = typeof error === "string" ? error : describeError(error);
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function verifyMfaAction(formData: FormData): Promise<void> {
  const token = await readMfaChallengeCookie();
  if (!token) {
    fail("/login", "Your sign-in session expired. Enter your password again.");
  }
  const db = getDb();
  const challenge = await findMfaChallenge(db, token, "login");
  if (!challenge) {
    await clearMfaChallengeCookie();
    fail("/login", "Your sign-in session expired. Enter your password again.");
  }
  const meta = await requestMeta();
  const perUser = await consumeRateLimit(db, {
    bucket: "mfa_verify_user",
    key: challenge.userId,
    limit: 10,
    windowSeconds: 300,
  });
  const perIp = await consumeRateLimit(db, {
    bucket: "mfa_verify_ip",
    key: meta.ipAddress ?? "unknown",
    limit: 20,
    windowSeconds: 300,
  });
  if (!perUser.allowed || !perIp.allowed) {
    await consumeMfaChallenge(db, challenge.id);
    await clearMfaChallengeCookie();
    fail("/login", "Too many verification attempts. Sign in again in a few minutes.");
  }

  const code = field(formData, "code");
  if (!code) fail("/mfa", "Enter your authenticator code or a recovery code");
  const verified = await verifySecondFactor(db, challenge.userId, code, {
    purpose: "login",
    ipAddress: meta.ipAddress,
  });

  if (!verified.ok) {
    const attempts = await recordChallengeFailure(db, challenge.id);
    if (attempts >= 5) {
      await clearMfaChallengeCookie();
      fail("/login", "Too many invalid codes. Sign in again.");
    }
    fail("/mfa", `Invalid code. ${Math.max(0, 5 - attempts)} attempt${5 - attempts === 1 ? "" : "s"} remaining.`);
  }

  await consumeMfaChallenge(db, challenge.id);
  const session = await createSession(db, challenge.userId, meta);
  await setSessionCookie(session.token, session.expiresAt);
  await clearMfaChallengeCookie();

  const next = safeNextPath(challenge.nextPath);
  if (verified.method === "recovery") {
    redirect(
      `${next}${next.includes("?") ? "&" : "?"}ok=${encodeURIComponent("Signed in with a recovery code. Review your MFA settings.")}`,
    );
  }
  redirect(next);
}

export async function startMfaSetupAction(formData: FormData): Promise<void> {
  const context = await getMfaSetupContext();
  if (!context) fail("/login", "Your setup session expired. Sign in again.");
  const db = getDb();
  const meta = await requestMeta();
  const rate = await consumeRateLimit(db, {
    bucket: "mfa_setup_user",
    key: context.userId,
    limit: 10,
    windowSeconds: 3600,
  });
  if (!rate.allowed) fail("/mfa/setup", "Too many setup attempts. Try again later.");

  try {
    await startMfaEnrollment(db, context.userId, {
      password: field(formData, "password") || undefined,
      trusted: context.mode === "enroll",
      ipAddress: meta.ipAddress,
    });
  } catch (error) {
    fail("/mfa/setup", error);
  }
  redirect("/mfa/setup");
}

export type MfaConfirmState = { error?: string; codes?: string[] };

export async function confirmMfaAction(
  _previous: MfaConfirmState,
  formData: FormData,
): Promise<MfaConfirmState> {
  const context = await getMfaSetupContext();
  if (!context) return { error: "Your setup session expired. Sign in again." };
  const db = getDb();
  const meta = await requestMeta();
  const rate = await consumeRateLimit(db, {
    bucket: "mfa_confirm_user",
    key: context.userId,
    limit: 15,
    windowSeconds: 3600,
  });
  if (!rate.allowed) return { error: "Too many confirmation attempts. Try again later." };

  const code = field(formData, "code");
  if (!code) return { error: "Enter the 6-digit code from your authenticator" };

  try {
    const result = await confirmMfaEnrollment(db, context.userId, code, { ipAddress: meta.ipAddress });
    if (!result.ok) return { error: result.error ?? "Invalid code" };

    if (context.mode === "session") {
      const current = await readSessionToken();
      if (current) await revokeOtherSessions(db, context.userId, current);
    } else {
      const enrollToken = await readMfaEnrollCookie();
      if (enrollToken) {
        const challenge = await findMfaChallenge(db, enrollToken, "enroll");
        if (challenge) await consumeMfaChallenge(db, challenge.id);
      }
      const session = await createSession(db, context.userId, meta);
      await setSessionCookie(session.token, session.expiresAt);
      await clearMfaEnrollCookie();
    }
    revalidatePath("/app", "layout");
    return { codes: result.recoveryCodes ?? [] };
  } catch (error) {
    logServerError("mfa_confirm_failed", error);
    return { error: describeError(error) };
  }
}

export async function disableMfaAction(formData: FormData): Promise<void> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  const db = getDb();
  const meta = await requestMeta();
  const rate = await consumeRateLimit(db, {
    bucket: "mfa_disable_user",
    key: actor.user.id,
    limit: 10,
    windowSeconds: 3600,
  });
  if (!rate.allowed) fail("/mfa/disable", "Too many attempts. Try again later.");

  const password = field(formData, "password");
  const code = field(formData, "code");
  if (!password || !code) fail("/mfa/disable", "Password and a current code are required");
  try {
    await disableMfa(db, actor.user.id, { password, code }, { ipAddress: meta.ipAddress });
  } catch (error) {
    fail("/mfa/disable", error);
  }
  await clearMfaChallengeCookie();
  await clearMfaEnrollCookie();
  redirect("/login?ok=" + encodeURIComponent("MFA disabled. All sessions were signed out."));
}
