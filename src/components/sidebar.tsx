"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction, switchOrgAction } from "@/app/auth-actions";

type Org = { id: string; name: string; kind: string; role: string };

type Props = {
  user: { name: string; email: string };
  org: { id: string; name: string; role: string; viaAdvisorAccess: boolean };
  orgs: Org[];
  permissions: string[];
  isPlatformAdmin: boolean;
  unreadCount: number;
};

const SECTIONS: { label: string; items: { href: string; label: string; permission: string }[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/app/dashboard", label: "Dashboard", permission: "org:read" },
      { href: "/app/sales", label: "Sales", permission: "finance:read" },
      { href: "/app/expenses", label: "Expenses", permission: "finance:read" },
      { href: "/app/invoices", label: "Invoices", permission: "finance:read" },
      { href: "/app/contacts", label: "Customers & suppliers", permission: "finance:read" },
      { href: "/app/reports", label: "Reports & exports", permission: "finance:read" },
    ],
  },
  {
    label: "Advisory",
    items: [
      { href: "/app/documents", label: "Documents", permission: "documents:read" },
      { href: "/app/tenders", label: "Tender intelligence", permission: "tenders:read" },
      { href: "/app/reconciliation", label: "Reconciliation", permission: "recon:read" },
    ],
  },
  {
    label: "Organization",
    items: [
      { href: "/app/team", label: "Team & advisors", permission: "team:manage" },
      { href: "/app/audit", label: "Audit log", permission: "audit:read" },
      { href: "/app/settings", label: "Settings", permission: "org:read" },
    ],
  },
];

export function Sidebar({ user, org, orgs, permissions, isPlatformAdmin, unreadCount }: Props) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link href="/app/dashboard" className="brand">
        <span className="brand-mark">LL</span>
        <span>
          Ledgerline
          <small>Business intelligence</small>
        </span>
      </Link>

      <form action={switchOrgAction} className="org-picker">
        <label htmlFor="orgId">Organization</label>
        <input type="hidden" name="returnTo" value={pathname} />
        <select id="orgId" name="orgId" defaultValue={org.id}>
          {orgs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.role.replace("_", " ")}
            </option>
          ))}
        </select>
        <button className="btn secondary small mt-1" type="submit" style={{ width: "100%" }}>
          Switch
        </button>
      </form>

      <nav className="nav">
        {SECTIONS.map((section) => {
          const visible = section.items.filter((item) => permissions.includes(item.permission));
          if (visible.length === 0) return null;
          return (
            <div key={section.label}>
              <div className="nav-group">{section.label}</div>
              {visible.map((item) => {
                const active =
                  item.href === "/app/dashboard"
                    ? pathname === item.href
                    : pathname.startsWith(item.href);
                return (
                  <Link key={item.href} href={item.href} className={active ? "active" : undefined}>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
        <div>
          <div className="nav-group">Inbox</div>
          <Link href="/app/notifications" className={pathname.startsWith("/app/notifications") ? "active" : undefined}>
            Notifications{unreadCount > 0 ? ` (${unreadCount})` : ""}
          </Link>
          <Link href="/app/tasks" className={pathname.startsWith("/app/tasks") ? "active" : undefined}>
            Tasks
          </Link>
        </div>
        {isPlatformAdmin ? (
          <div>
            <div className="nav-group">Platform</div>
            <Link href="/admin" className={pathname.startsWith("/admin") ? "active" : undefined}>
              Administration
            </Link>
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <span className="who">{user.name}</span>
        <span>{user.email}</span>
        <div className="tiny" style={{ marginTop: "0.35rem" }}>
          {org.viaAdvisorAccess ? "Advisor access (client-authorized)" : `Role: ${org.role.replace("_", " ")}`}
        </div>
        <form action={logoutAction} className="mt-1">
          <button className="btn secondary small" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
