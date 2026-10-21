"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
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
  deliverEmail,
  requestMeta,
  safeNextPath,
  tokenLinksExposed,
} from "@/lib/request";
import {
  clearSessionCookie,
  readSessionToken,
  setActiveOrgCookie,
  setSessionCookie,
} from "@/lib/session-cookie";
import { getCurrentActor } from "@/lib/current-user";

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fail(path: string, error: unknown): never {
  redirect(`${path}?error=${encodeURIComponent(describeError(error))}`);
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
  const db = getDb();
  const meta = await requestMeta();
  const name = str(formData, "name");
  const email = str(formData, "email");
  const password = str(formData, "password");
  const organizationName = str(formData, "organizationName");
  const organizationKind =
    str(formData, "organizationKind") === "accounting_firm" ? "accounting_firm" : "business";
  const currency = str(formData, "currency") || "RWF";

  let verifyPath: string | null = null;
  try {
    const result = await registerUser(
      db,
      { name, email, password, organizationName, organizationKind, currency },
      meta,
    );
    const session = await createSession(db, result.userId, meta);
    await setSessionCookie(session.token, session.expiresAt);
    await deliverEmail({
      to: email,
      subject: "Verify your Ledgerline email",
      link: `${appUrl()}/verify-email?token=${result.emailVerificationToken}`,
    });
    if (tokenLinksExposed()) {
      verifyPath = `/verify-email?token=${encodeURIComponent(result.emailVerificationToken)}`;
    }
  } catch (error) {
    fail("/register", error);
  }

  redirect(
    verifyPath
      ? `/app/dashboard?ok=${encodeURIComponent("Account created. Verify your email below.")}&verify=${encodeURIComponent(verifyPath)}`
      : `/app/dashboard?ok=${encodeURIComponent("Account created. Check your inbox to verify your email.")}`,
  );
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
  let link: string | null = null;
  try {
    const token = await createPasswordResetToken(db, email);
    if (token) {
      link = `${appUrl()}/reset-password?token=${token}`;
      await deliverEmail({ to: email, subject: "Reset your Ledgerline password", link });
    }
  } catch (error) {
    fail("/forgot-password", error);
  }
  const message =
    "If an account exists for that email, a reset link has been created. Check your inbox.";
  redirect(
    tokenLinksExposed() && link
      ? `/forgot-password?ok=${encodeURIComponent(message)}&link=${encodeURIComponent(link)}`
      : `/forgot-password?ok=${encodeURIComponent(message)}`,
  );
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
