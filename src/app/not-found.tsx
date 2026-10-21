import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-main" style={{ minHeight: "100vh" }}>
      <div className="auth-card center">
        <div className="eyebrow">404</div>
        <h1>Page not found</h1>
        <p className="muted">The page may have been moved, or you may not have access to it.</p>
        <Link className="btn" href="/app/dashboard">Back to workspace</Link>
      </div>
    </main>
  );
}
