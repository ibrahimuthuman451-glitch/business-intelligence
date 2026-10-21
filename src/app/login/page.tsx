import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { loginAction } from "../auth-actions";
import { safeNextPath } from "@/lib/request";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; next?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell title="Sign in" subtitle="Use the email you registered with.">
      <Feedback ok={params.ok} error={params.error} />
      <form action={loginAction}>
        <input type="hidden" name="next" value={safeNextPath(params.next)} />
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button className="btn" type="submit" style={{ width: "100%" }}>
          Sign in
        </button>
      </form>
      <div className="auth-footer">
        <Link href="/forgot-password">Forgot your password?</Link>
        <span className="muted"> · </span>
        New here? <Link href="/register">Create an account</Link>
      </div>
    </AuthShell>
  );
}
