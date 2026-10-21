import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { registerAction } from "../auth-actions";

export const metadata: Metadata = { title: "Create an account" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell
      title="Create your workspace"
      subtitle="Set up your business or accounting firm. You can invite your team afterwards."
    >
      <Feedback error={params.error} />
      <form action={registerAction}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="name">Your full name</label>
            <input id="name" name="name" required minLength={2} autoComplete="name" />
          </div>
          <div className="field">
            <label htmlFor="organizationName">Organization name</label>
            <input id="organizationName" name="organizationName" required minLength={2} />
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="organizationKind">Organization type</label>
            <select id="organizationKind" name="organizationKind" defaultValue="business">
              <option value="business">Business</option>
              <option value="accounting_firm">Accounting firm</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="currency">Reporting currency</label>
            <select id="currency" name="currency" defaultValue="RWF">
              <option value="RWF">RWF</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="KES">KES</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
          <span className="hint">At least 12 characters, including a letter and a number.</span>
        </div>
        <button className="btn accent" type="submit" style={{ width: "100%" }}>
          Create account
        </button>
      </form>
      <div className="auth-footer">
        Already have an account? <Link href="/login">Sign in</Link>
      </div>
    </AuthShell>
  );
}
