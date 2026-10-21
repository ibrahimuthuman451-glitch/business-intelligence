import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <Link href="/" className="brand">
          <span className="brand-mark">LL</span>
          <span>
            Ledgerline
            <small>Business intelligence</small>
          </span>
        </Link>
        <div>
          <h1>Clarity for the numbers behind your business.</h1>
          <p>
            One workspace for books, tax documents, tender readiness and reconciliation — with your
            accountant working from the same records.
          </p>
          <ul>
            <li>Live financial position from your own records</li>
            <li>Private document rooms with review status</li>
            <li>Verified tender intake with provenance</li>
            <li>Advisor access you authorize and can revoke</li>
          </ul>
        </div>
        <p className="tiny" style={{ color: "#8493aa" }}>
          Ledgerline is not affiliated with RRA. Imports are file-based; we never ask for government
          portal passwords.
        </p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <h1>{title}</h1>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
          {children}
        </div>
      </main>
    </div>
  );
}
