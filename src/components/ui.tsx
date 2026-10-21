import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <div className="small">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  paid: "green",
  approved: "green",
  active: "green",
  ready: "green",
  fulfilled: "green",
  resolved: "green",
  completed: "green",
  sent: "blue",
  in_review: "blue",
  processing: "blue",
  in_progress: "blue",
  partially_paid: "amber",
  pending: "amber",
  open: "amber",
  uploaded: "gray",
  draft: "gray",
  unknown: "gray",
  accepted: "amber",
  rejected: "red",
  overdue: "red",
  failed: "red",
  revoked: "red",
  error: "red",
  warning: "amber",
  info: "blue",
  owner: "accent",
  advisor: "blue",
  staff: "gray",
  firm_admin: "accent",
  platform_admin: "red",
  manual_import: "blue",
  sample: "amber",
  authorized_feed: "green",
  likely: "green",
  unlikely: "red",
  suspended: "red",
  cancelled: "gray",
  dismissed: "gray",
  void: "gray",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = BADGE_TONES[value] ?? "gray";
  return <span className={`badge ${tone}`}>{label ?? value.replace(/_/g, " ")}</span>;
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warn" | "error";
  children: ReactNode;
}) {
  return (
    <div className={`alert ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Feedback({ ok, error }: { ok?: string; error?: string }) {
  return (
    <>
      {ok ? (
        <Alert tone="success">
          <span>{ok}</span>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error">
          <span>{error}</span>
        </Alert>
      ) : null}
    </>
  );
}
