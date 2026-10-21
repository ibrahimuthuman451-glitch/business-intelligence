import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { AuthShell } from "@/components/auth-shell";
import { Alert, Feedback } from "@/components/ui";
import { getCurrentActor } from "@/lib/current-user";
import { getMfaStatus } from "@/lib/mfa/service";
import { disableMfaAction } from "../actions";

export const metadata: Metadata = { title: "Disable MFA" };
export const dynamic = "force-dynamic";

export default async function DisableMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/login?next=/mfa/disable");
  const status = await getMfaStatus(getDb(), actor.user.id);
  if (!status.enabled) redirect("/mfa/setup");

  return (
    <AuthShell
      title="Disable two-step verification"
      subtitle="This removes the authenticator secret and all recovery codes, then signs out every session."
    >
      <Feedback error={params.error} />
      {status.requiredByPolicy ? (
        <Alert tone="warn">
          MFA is required for your role. An administrator must change the policy before it can be
          disabled.
        </Alert>
      ) : (
        <form action={disableMfaAction}>
          <div className="field">
            <label htmlFor="password">Current password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          <div className="field">
            <label htmlFor="code">Authenticator code or recovery code</label>
            <input id="code" name="code" required autoComplete="one-time-code" />
          </div>
          <button className="btn danger" type="submit" style={{ width: "100%" }}>
            Disable MFA
          </button>
        </form>
      )}
      <div className="auth-footer">
        <Link href="/app/settings">Back to settings</Link>
      </div>
    </AuthShell>
  );
}
