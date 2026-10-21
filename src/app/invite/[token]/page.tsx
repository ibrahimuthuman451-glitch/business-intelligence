import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { Feedback } from "@/components/ui";
import { getDb } from "@/db/client";
import { findInvitationByToken, invitationProblem } from "@/lib/team";
import { getCurrentActor } from "@/lib/current-user";
import { acceptInvitationAction, loginAction } from "../../auth-actions";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const invite = await findInvitationByToken(getDb(), token);
  const problem = invitationProblem(invite);
  const actor = await getCurrentActor();

  if (!invite || problem) {
    return (
      <AuthShell title="Invitation unavailable" subtitle={problem ?? "This invitation link is invalid."}>
        <Link className="btn" href="/login">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  const wrongAccount = actor && actor.user.email.toLowerCase() !== invite.email;

  return (
    <AuthShell
      title={`Join ${invite.orgName}`}
      subtitle={`You were invited as ${invite.role.replace("_", " ")} for ${invite.email}.`}
    >
      <Feedback error={query.error} />
      {wrongAccount ? (
        <div className="alert warn">
          You are signed in as <strong>{actor?.user.email}</strong>. This invitation is for{" "}
          <strong>{invite.email}</strong>. Sign out and sign back in with the invited address.
        </div>
      ) : null}

      {actor && !wrongAccount ? (
        <form action={acceptInvitationAction}>
          <input type="hidden" name="token" value={token} />
          <button className="btn accent" type="submit" style={{ width: "100%" }}>
            Accept invitation
          </button>
        </form>
      ) : null}

      {!actor ? (
        <>
          <form action={acceptInvitationAction}>
            <input type="hidden" name="token" value={token} />
            <div className="field">
              <label htmlFor="name">Your full name</label>
              <input id="name" name="name" required minLength={2} />
            </div>
            <div className="field">
              <label>Email</label>
              <input value={invite.email} readOnly disabled />
            </div>
            <div className="field">
              <label htmlFor="password">Create a password</label>
              <input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
              <span className="hint">At least 12 characters with a letter and a number.</span>
            </div>
            <button className="btn accent" type="submit" style={{ width: "100%" }}>
              Create account and accept
            </button>
          </form>
          <div className="divider" />
          <p className="small muted">Already have an account? Sign in first, then reopen this link.</p>
          <form action={loginAction}>
            <input type="hidden" name="next" value={`/invite/${token}`} />
            <input type="hidden" name="email" value={invite.email} />
            <div className="field">
              <label htmlFor="existing-password">Password</label>
              <input id="existing-password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <button className="btn secondary" type="submit" style={{ width: "100%" }}>
              Sign in and accept
            </button>
          </form>
        </>
      ) : null}

      {wrongAccount ? (
        <Link className="btn secondary" href="/login">
          Sign in with the invited address
        </Link>
      ) : null}
    </AuthShell>
  );
}
