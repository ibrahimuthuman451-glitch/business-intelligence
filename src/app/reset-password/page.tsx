import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { resetPasswordAction } from "../auth-actions";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell title="Choose a new password" subtitle="All existing sessions will be signed out.">
      <Feedback error={params.error} />
      {!params.token ? (
        <div className="alert warn">This page needs a reset token. Request a new link.</div>
      ) : (
        <form action={resetPasswordAction}>
          <input type="hidden" name="token" value={params.token} />
          <div className="field">
            <label htmlFor="password">New password</label>
            <input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">Confirm new password</label>
            <input id="confirmPassword" name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" />
          </div>
          <button className="btn" type="submit" style={{ width: "100%" }}>
            Update password
          </button>
        </form>
      )}
      <div className="auth-footer">
        <Link href="/login">Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
