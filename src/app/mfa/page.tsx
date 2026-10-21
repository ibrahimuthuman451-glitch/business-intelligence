import Link from "next/link";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { readMfaChallengeCookie } from "@/lib/session-cookie";
import { findMfaChallenge } from "@/lib/mfa/service";
import { verifyMfaAction } from "./actions";

export const metadata: Metadata = { title: "Two-step verification" };
export const dynamic = "force-dynamic";

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const token = await readMfaChallengeCookie();
  const challenge = token ? await findMfaChallenge(getDb(), token, "login") : null;
  const [user] = challenge
    ? await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, challenge.userId))
        .limit(1)
    : [];

  if (!challenge || !user) {
    return (
      <AuthShell title="Verification expired" subtitle="For your security, sign in again to request a new code.">
        <Link className="btn" href="/login">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Two-step verification"
      subtitle={`Enter the code for ${user.email}. A recovery code also works.`}
    >
      <Feedback ok={params.ok} error={params.error} />
      <form action={verifyMfaAction}>
        <div className="field">
          <label htmlFor="code">Authenticator code or recovery code</label>
          <input
            id="code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            placeholder="123456 or ABCDE-12345"
            required
          />
        </div>
        <button className="btn" type="submit" style={{ width: "100%" }}>
          Verify and sign in
        </button>
      </form>
      <div className="auth-footer">
        <Link href="/login">Cancel and sign in again</Link>
      </div>
    </AuthShell>
  );
}
