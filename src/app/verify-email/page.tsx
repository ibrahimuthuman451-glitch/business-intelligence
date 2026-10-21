import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { getCurrentActor } from "@/lib/current-user";
import { resendVerificationAction, verifyEmailAction } from "../auth-actions";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; ok?: string; link?: string }>;
}) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  return (
    <AuthShell title="Verify your email" subtitle="Confirm the address used for sign-in and alerts.">
      <Feedback ok={params.ok} error={params.error} />
      {params.token ? (
        <form action={verifyEmailAction} method="post">
          <input type="hidden" name="token" value={params.token} />
          <button className="btn" type="submit" style={{ width: "100%" }}>
            Verify this email
          </button>
        </form>
      ) : actor ? (
        <>
          <div className="alert warn">This page needs a verification token from your email.</div>
          {!actor.user.emailVerifiedAt ? (
            <form action={resendVerificationAction}>
              <button className="btn" type="submit" style={{ width: "100%" }}>
                Resend verification email
              </button>
            </form>
          ) : (
            <div className="alert success">Your email is already verified.</div>
          )}
          {params.link ? <div className="alert info small">Development link: <a href={params.link}>verify now</a></div> : null}
        </>
      ) : (
        <div className="alert warn">This page needs a verification token from your email.</div>
      )}
      <div className="auth-footer">
        <Link href="/app/dashboard">Continue to workspace</Link>
      </div>
    </AuthShell>
  );
}
