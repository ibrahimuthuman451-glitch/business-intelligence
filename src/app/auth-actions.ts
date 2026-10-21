"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { verificationTokens } from "@/db/schema";
import {
  authenticate,
  createPasswordResetToken,
  createSession,
  registerUser,
  resetPassword,
  revokeSession,
  verifyEmail,
} from "@/lib/auth";
import { acceptInvitationForUser, registerInvitedUser } from "@/lib/team";
import {
  appUrl,
  describeError,
  requestMeta,
  safeNextPath,
} from "@/lib/request";
import {
  clearSessionCookie,
  readSessionToken,
  setActiveOrgCookie,
  setSessionCookie,
} from "@/lib/session-cookie";
import { getCurrentActor } from "@/lib/current-user";
import { isEmailConfigured, linksVisibleInUi } from "@/lib/email";
import { sendEmail } from "@/lib/email/outbox";
import { passwordResetEmailWithToken, verificationEmailWithToken } from "@/lib/email/templates";
import { consumeRateLimit } from "@/lib/rate-limit";
import { hashToken, normalizeEmail, randomToken } from "@/lib/ids";
import { recordAuditSafe } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { logServerError } from "@/lib/logger";

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fail(path: string, error: unknown): never {
  redirect(`${path}?error=${encodeURIComponent(describeError(error))}`);
}

function deliveryNotice(status: string, subject: string): string {
  if (status === "sent" || status === "duplicate") return `${subject} sent.`;
  if (status === "queued") return `${subject} queued; delivery will be retried automatically.`;
  return `${subject} could not be delivered. Contact your administrator or retry later.`;
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = str(formData, "email");
  const password = str(formData, "password");
  const next = safeNextPath(str(formData, "next"));
  const db = getDb();
  const meta = await requestMeta();

  if (!email || !password) fail("/login", "Enter your email and password");

  try {
    const user = await authenticate(db, email, password, meta);
    const session = await createSession(db, user.id, meta);
    await setSessionCookie(session.token, session.expiresAt);
  } catch (error) {
    fail(`/login?next=${encodeURIComponent(next)}`, error);
  }
  redirect(next);
}

export async function registerAction(formData: FormData): Promise<void> {
  if (process.env.NODE_ENV === "production" && !isEmailConfigured()) {
    fail(
      "/register",
      "Registration is temporarily unavailable because email delivery is not configured. Please contact the operator.",
    );
  }
  const db = getDb();
  const meta = await requestMeta();
  const name = str(formData, "name");
  const email = normalizeEmail(str(formData, "email"));
  const password = str(formData, "password");
  const organizationName = str(formData, "organizationName");
  const organizationKind =
    str(formData, "organizationKind") === "accounting_firm" ? "accounting_firm" : "business";
  const currency = str(formData, "currency") || "RWF";

  let verifyPath: string | null = null;
  let notice = "";
  try {
    const result = await registerUser(
      db,
      { name, email, password, organizationName, organizationKind, currency },
      meta,
    );
    const session = await createSession(db, result.userId, meta);
    await setSessionCookie(session.token, session.expiresAt);
    verifyPath = `/verify-email?token=${encodeURIComponent(result.emailVerificationToken)}`;

    const rendered = verificationEmailWithToken(result.emailVerificationToken);
    const delivery = await sendEmail(db, {
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: "auth.verify_email",
    });
    notice = deliveryNotice(delivery.status, "Verification email");
    await recordAuditSafe(db, {
      orgId: result.organizationId,
      actorUserId: result.userId,
      actorEmail: email,
      action: `email.verification_${delivery.status}`,
      metadata: { kind: "auth.verify_email" },
    });
  } catch (error) {
    fail("/register", error);
  }

  const devLink = linksVisibleInUi() && verifyPath ? `&verify=${encodeURIComponent(verifyPath)}` : "";
  redirect(`/app/dashboard?ok=${encodeURIComponent(`Account created. ${notice}`)}${devLink}`);
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) await revokeSession(getDb(), token);
  await clearSessionCookie();
  redirect("/login?ok=" + encodeURIComponent("You have been signed out."));
}

export async function forgotPasswordAction(formData: FormData): Promise<void> {
  const email = str(formData, "email");
  const db = getDb();
  const meta = await requestMeta();
  const limitEmail = await consumeRateLimit(db, {
    bucket: "password_reset_email",
    key: normalizeEmail(email),
    limit: 3,
    windowSeconds: 3600,
  });
  const limitIp = await consumeRateLimit(db, {
    bucket: "password_reset_ip",
    key: meta.ipAddress ?? "unknown",
    limit: 10,
    windowSeconds: 3600,
  });

  let link: string | null = null;
  let notice = "";
  if (!limitEmail.allowed || !limitIp.allowed) {
    await recordAuditSafe(db, {
      actorEmail: normalizeEmail(email),
      action: "auth.password_reset_rate_limited",
      ipAddress: meta.ipAddress,
    });
    notice = "Too many requests. Try again later.";
  } else {
    try {
      const token = await createPasswordResetToken(db, email);
      if (token) {
        link = `${appUrl()}/reset-password?token=${token}`;
        const rendered = passwordResetEmailWithToken(token);
        const delivery = await sendEmail(db, {
          to: normalizeEmail(email),
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: "auth.password_reset",
        });
        notice = deliveryNotice(delivery.status, "Password reset email");
        await recordAuditSafe(db, {
          actorEmail: normalizeEmail(email),
          action: `email.password_reset_${delivery.status}`,
          ipAddress: meta.ipAddress,
        });
      }
    } catch (error) {
      logServerError("password_reset_email_failed", error);
      notice = "The reset email could not be sent. Contact your administrator.";
    }
  }

  const generic =
    "If an account exists for that email, a reset link has been created. Check your inbox.";
  // Never reveal whether an account exists in production.
  const message = linksVisibleInUi() && notice ? `${generic} ${notice}` : generic;
  const devLink = linksVisibleInUi() && link ? `&link=${encodeURIComponent(link)}` : "";
  redirect(`/forgot-password?ok=${encodeURIComponent(message)}${devLink}`);
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = str(formData, "token");
  const password = str(formData, "password");
  const confirm = str(formData, "confirmPassword");
  if (password !== confirm) {
    redirect(
      `/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent("Passwords do not match")}`,
    );
  }
  try {
    await resetPassword(getDb(), token, password);
  } catch (error) {
    fail(`/reset-password?token=${encodeURIComponent(token)}`, error);
  }
  redirect("/login?ok=" + encodeURIComponent("Password updated. Sign in with your new password."));
}

export async function verifyEmailAction(formData: FormData): Promise<void> {
  const token = str(formData, "token");
  try {
    await verifyEmail(getDb(), token);
  } catch (error) {
    fail(`/verify-email?token=${encodeURIComponent(token)}`, error);
  }
  redirect("/app/dashboard?ok=" + encodeURIComponent("Email verified."));
}

export async function resendVerificationAction(): Promise<void> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  const db = getDb();
  const limit = await consumeRateLimit(db, {
    bucket: "verify_resend_user",
    key: actor.user.id,
    limit: 3,
    windowSeconds: 3600,
  });
  if (!limit.allowed) fail("/verify-email", "Too many verification emails requested. Try again later.");
  if (actor.user.emailVerifiedAt) redirect("/app/dashboard?ok=" + encodeURIComponent("Email is already verified."));

  try {
    await db
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(verificationTokens.userId, actor.user.id), eq(verificationTokens.purpose, "email_verify")));
    const token = randomToken();
    await db.insert(verificationTokens).values({
      userId: actor.user.id,
      purpose: "email_verify",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });
    const rendered = verificationEmailWithToken(token);
    const delivery = await sendEmail(db, {
      to: actor.user.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: "auth.verify_email",
    });
    if (delivery.status === "failed") {
      fail("/verify-email", "The verification email could not be sent. Contact your administrator.");
    }
    const devLink = linksVisibleInUi() ? `&link=${encodeURIComponent(rendered.link)}` : "";
    redirect(`/verify-email?ok=${encodeURIComponent(deliveryNotice(delivery.status, "Verification email"))}${devLink}`);
  } catch (error) {
    if (error instanceof AppError) fail("/verify-email", error);
    fail("/verify-email", error);
  }
}

export async function switchOrgAction(formData: FormData): Promise<void> {
  const orgId = str(formData, "orgId");
  const returnTo = safeNextPath(str(formData, "returnTo"));
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  if (orgId) await setActiveOrgCookie(orgId);
  revalidatePath("/app", "layout");
  redirect(returnTo);
}

export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const token = str(formData, "token");
  const db = getDb();
  const actor = await getCurrentActor();

  if (actor) {
    try {
      const result = await acceptInvitationForUser(db, token, actor.user.id);
      await setActiveOrgCookie(result.orgId);
    } catch (error) {
      fail(`/invite/${token}`, error);
    }
    redirect("/app/dashboard?ok=" + encodeURIComponent("Invitation accepted."));
  }

  const name = str(formData, "name");
  const password = str(formData, "password");
  const meta = await requestMeta();
  try {
    const result = await registerInvitedUser(db, token, { name, password });
    const session = await createSession(db, result.userId, meta);
    await setSessionCookie(session.token, session.expiresAt);
    await setActiveOrgCookie(result.orgId);
  } catch (error) {
    fail(`/invite/${token}`, error);
  }
  redirect("/app/dashboard?ok=" + encodeURIComponent("Invitation accepted. Welcome."));
}
