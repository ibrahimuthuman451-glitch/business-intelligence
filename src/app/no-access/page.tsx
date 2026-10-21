import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

export default function NoAccessPage() {
  return (
    <AuthShell
      title="No access"
      subtitle="Your account has no active access to this workspace. Ask the business owner for an invitation, or switch organization."
    >
      <div className="row">
        <Link className="btn" href="/app/dashboard">
          Back to workspace
        </Link>
        <Link className="btn secondary" href="/login">
          Sign in as someone else
        </Link>
      </div>
    </AuthShell>
  );
}
