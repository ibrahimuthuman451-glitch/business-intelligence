import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { forgotPasswordAction } from "../auth-actions";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; link?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell title="Reset your password" subtitle="We will create a single-use reset link.">
      <Feedback ok={params.ok} error={params.error} />
      {params.link ? (
        <div className="alert info small">
          Development mode: open <Link href={params.link}>your reset link</Link>. No email provider is
          configured, so links are logged on the server.
        </div>
      ) : null}
      <form action={forgotPasswordAction}>
        <div className="field">
          <label htmlFor="email">Account email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <button className="btn" type="submit" style={{ width: "100%" }}>
          Send reset link
        </button>
      </form>
      <div className="auth-footer">
        <Link href="/login">Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
