"use client";

import Link from "next/link";
import { useActionState } from "react";
import { confirmMfaAction, type MfaConfirmState } from "@/app/mfa/actions";

const initial: MfaConfirmState = {};

export function MfaSetupForm() {
  const [state, formAction, pending] = useActionState(confirmMfaAction, initial);

  if (state.codes && state.codes.length > 0) {
    return (
      <div>
        <div className="alert success">
          MFA is enabled. Store these recovery codes somewhere safe. They are shown once and each
          can be used a single time.
        </div>
        <ul className="list card card-pad mono" style={{ letterSpacing: "0.08em" }}>
          {state.codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <p className="small muted">
          If you lose your authenticator, use one recovery code to sign in, then disable and
          re-enroll your device. Treat these codes like passwords.
        </p>
        <Link className="btn accent" href="/app/dashboard">
          Continue to workspace
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction}>
      {state.error ? <div className="alert error">{state.error}</div> : null}
      <div className="field">
        <label htmlFor="code">6-digit authenticator code</label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
        <span className="hint">Enter the current code to confirm enrollment.</span>
      </div>
      <button className="btn accent" type="submit" disabled={pending}>
        {pending ? "Confirming…" : "Confirm and enable MFA"}
      </button>
    </form>
  );
}
