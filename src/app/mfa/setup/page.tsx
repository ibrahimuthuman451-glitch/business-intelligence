import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { AuthShell } from "@/components/auth-shell";
import { Alert, Feedback } from "@/components/ui";
import { MfaSetupForm } from "@/components/mfa-setup-form";
import { getMfaSetupContext } from "@/lib/mfa/setup-context";
import { getMfaStatus, pendingEnrollmentSecret } from "@/lib/mfa/service";
import { startMfaSetupAction } from "../actions";

export const metadata: Metadata = { title: "Set up MFA" };
export const dynamic = "force-dynamic";

export default async function MfaSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; required?: string }>;
}) {
  const params = await searchParams;
  const context = await getMfaSetupContext();
  if (!context) {
    redirect("/login?error=" + encodeURIComponent("Sign in to set up MFA."));
  }
  const status = await getMfaStatus(getDb(), context.userId);
  const pending = status.enabled ? null : await pendingEnrollmentSecret(getDb(), context.userId);

  return (
    <AuthShell
      title="Two-step verification"
      subtitle={
        status.enabled
          ? "MFA is active for this account."
          : "Protect your account with an authenticator app (TOTP)."
      }
    >
      <Feedback error={params.error} />
      {params.required && !status.enabled ? (
        <Alert tone="warn">
          Your role requires MFA. You must finish setup before accessing organization data.
        </Alert>
      ) : null}

      {status.enabled ? (
        <div className="stack">
          <Alert tone="success">
            MFA is enabled. {status.recoveryCodesRemaining} recovery code(s) remaining.
          </Alert>
          {status.requiredByPolicy ? (
            <p className="small muted">MFA is required for your role and cannot be disabled here.</p>
          ) : (
            <Link className="btn secondary" href="/mfa/disable">
              Disable MFA
            </Link>
          )}
          {context.mode === "session" ? (
            <Link className="btn" href="/app/dashboard">
              Back to workspace
            </Link>
          ) : (
            <Link className="btn" href="/app/dashboard">
              Continue to workspace
            </Link>
          )}
        </div>
      ) : pending ? (
        <div className="stack">
          <Alert tone="info">
            Add this secret to Google Authenticator, Microsoft Authenticator, 1Password or another
            TOTP app. The secret is shown only until you confirm.
          </Alert>
          <div className="card card-pad">
            <div className="tiny muted">Manual setup key</div>
            <div className="mono strong" style={{ fontSize: "1.05rem", wordBreak: "break-all" }}>
              {pending.secret}
            </div>
            <div className="tiny muted mt-2">otpauth URI</div>
            <code className="tiny" style={{ wordBreak: "break-all" }}>{pending.uri}</code>
          </div>
          <MfaSetupForm />
          <p className="tiny muted">
            If you already loaded the secret into your app, enter the current 6-digit code. Setup
            cannot be completed without a valid code.
          </p>
        </div>
      ) : (
        <form action={startMfaSetupAction}>
          <p className="small muted">
            You will need an authenticator app. Recovery codes are generated after you confirm the
            first code.
          </p>
          {context.mode === "session" ? (
            <div className="field">
              <label htmlFor="password">Current password</label>
              <input id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
          ) : (
            <Alert tone="info">Your password was verified when you signed in.</Alert>
          )}
          <button className="btn accent" type="submit" style={{ width: "100%" }}>
            Generate authenticator secret
          </button>
        </form>
      )}

      <div className="auth-footer">
        {context.mode === "session" ? (
          <Link href="/app/settings">Back to settings</Link>
        ) : (
          <Link href="/login">Cancel and sign in again</Link>
        )}
      </div>
    </AuthShell>
  );
}
