import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { requirePageContext } from "@/lib/current-user";
import { Alert } from "@/components/ui";

export const metadata: Metadata = { title: "Workspace" };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, org, orgs } = await requirePageContext("org:read");
  const unverified = !actor.user.emailVerifiedAt;

  return (
    <div className="shell">
      <Sidebar
        user={{ name: actor.user.name, email: actor.user.email }}
        org={{ id: org.orgId, name: org.orgName, role: org.role, viaAdvisorAccess: org.viaAdvisorAccess }}
        orgs={orgs}
        permissions={org.permissions}
        isPlatformAdmin={actor.user.isPlatformAdmin}
      />
      <main className="main">
        {unverified ? (
          <Alert tone="warn">
            Your email is not verified yet. Check the verification link sent to{" "}
            <strong>{actor.user.email}</strong>.
          </Alert>
        ) : null}
        {org.viaAdvisorAccess ? (
          <Alert tone="info">
            You are working in <strong>{org.orgName}</strong> through client-authorized advisor
            access. The owner can revoke this access at any time, and every action is audited.
          </Alert>
        ) : null}
        {children}
      </main>
    </div>
  );
}
