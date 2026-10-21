import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { memberships, organizations } from "@/db/schema";
import { getCurrentActor } from "@/lib/current-user";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Platform administration" };
export const dynamic = "force-dynamic";

/**
 * Restricted platform administration. Shows organization metadata only, never
 * financial records, documents or tender contents, and requires an explicit
 * platform-admin flag rather than a tenant role.
 */
export default async function AdminPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login?next=/admin");
  if (!actor.user.isPlatformAdmin) redirect("/no-access?reason=forbidden");
  if (actor.mfaRequired && !actor.user.mfaEnabled) redirect("/mfa/setup");

  const rows = await getDb()
    .select({
      id: organizations.id,
      name: organizations.name,
      kind: organizations.kind,
      plan: organizations.plan,
      countryCode: organizations.countryCode,
      createdAt: organizations.createdAt,
      memberCount: sql<number>`(select count(*)::int from ${memberships} where ${memberships.orgId} = ${organizations.id})`,
    })
    .from(organizations)
    .orderBy(organizations.createdAt);

  return (
    <main className="main" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PageHeader
        eyebrow="Platform administration"
        title="Organizations"
        description="Metadata only. Platform administrators have no implicit access to tenant financial records, documents or tenders."
        actions={<Link className="btn secondary" href="/app/dashboard">Back to workspace</Link>}
      />
      <div className="card">
        <div className="card-head"><h2>Registered organizations</h2><span className="small muted">{rows.length}</span></div>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Name</th><th>Type</th><th>Plan</th><th>Country</th><th>Members</th><th>Created</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id}><td>{row.name}</td><td className="small">{row.kind.replace("_", " ")}</td><td className="small">{row.plan}</td><td className="small">{row.countryCode}</td><td className="small">{row.memberCount}</td><td className="small">{formatDate(row.createdAt)}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </main>
  );
}
