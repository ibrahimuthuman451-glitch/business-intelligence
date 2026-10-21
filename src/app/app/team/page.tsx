import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requirePageContext } from "@/lib/current-user";
import { listTeam } from "@/lib/team";
import { listAccessibleOrgs } from "@/lib/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { Alert, Badge, PageHeader } from "@/components/ui";
import { grantAdvisorAction, inviteMemberAction, revokeAdvisorAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Team & advisors" };
export const dynamic = "force-dynamic";

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org, actor } = await requirePageContext("team:manage");
  try {
    const [team, orgs] = await Promise.all([listTeam(getDb(), org.orgId), listAccessibleOrgs(actor)]);
    const firms = orgs.filter((item) => item.kind === "accounting_firm");
    return (
      <>
        <PageHeader
          eyebrow={org.orgName}
          title="Team & advisors"
          description="Staff you invite work inside this organization. Advisors need explicit client authorization before they can see anything."
        />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}

        <div className="grid grid-2 section">
          <div className="card">
            <div className="card-head"><h2>Invite a team member</h2></div>
            <form action={inviteMemberAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/team" />
              <div className="field"><label htmlFor="invite-email">Email</label><input id="invite-email" name="email" type="email" required /></div>
              <div className="field"><label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="staff"><option value="staff">Staff — day-to-day records</option><option value="advisor">Advisor — read/write books, review documents</option><option value="firm_admin">Firm administrator — manage advisors</option></select></div>
              <p className="tiny muted">Links are single-use and expire in 7 days. The invitee must use the invited email address.</p>
              <button className="btn" type="submit">Create invitation</button>
            </form>
          </div>
          <div className="card">
            <div className="card-head"><h2>Authorize an advisor</h2></div>
            <form action={grantAdvisorAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/team" />
              <div className="field"><label htmlFor="advisor-email">Advisor email</label><input id="advisor-email" name="advisorEmail" type="email" required /></div>
              <div className="field"><label htmlFor="firmOrgId">Accounting firm (optional)</label><select id="firmOrgId" name="firmOrgId" defaultValue=""><option value="">Independent advisor</option>{firms.map((firm) => <option key={firm.id} value={firm.id}>{firm.name}</option>)}</select></div>
              <p className="tiny muted">Access stays pending until the advisor accepts. You can revoke it at any time and every action is audit-logged.</p>
              <button className="btn secondary" type="submit">Create advisor authorization</button>
            </form>
          </div>
        </div>

        <div className="card section">
          <div className="card-head"><h2>Members</h2><span className="small muted">{team.members.length}</span></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Email verified</th></tr></thead>
            <tbody>{team.members.map((member) => (
              <tr key={member.membershipId}><td>{member.name}</td><td className="small">{member.email}</td><td><Badge value={member.role} /></td><td><Badge value={member.status} /></td><td className="small">{member.emailVerifiedAt ? formatDate(member.emailVerifiedAt) : <span style={{ color: "var(--amber)" }}>pending</span>}</td></tr>
            ))}</tbody>
          </table></div>
        </div>

        <div className="grid grid-2 section">
          <div className="card">
            <div className="card-head"><h2>Pending invitations</h2><span className="small muted">{team.pendingInvitations.length}</span></div>
            {team.pendingInvitations.length === 0 ? <div className="empty small">No pending invitations.</div> : (
              <ul className="list card-pad">{team.pendingInvitations.map((invitation) => (
                <li key={invitation.id} className="row-between"><div><div className="strong small">{invitation.email}</div><div className="tiny muted">{invitation.role} · {invitation.kind} · expires {formatDate(invitation.expiresAt)}</div></div><Badge value="pending" /></li>
              ))}</ul>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Advisor authorizations</h2><span className="small muted">{team.advisorGrants.length}</span></div>
            {team.advisorGrants.length === 0 ? <div className="empty small">No advisors authorized.</div> : (
              <ul className="list card-pad">{team.advisorGrants.map((grant) => (
                <li key={grant.id} className="row-between">
                  <div><div className="strong small">{grant.advisorEmail}</div><div className="tiny muted">{grant.firmOrgName ?? "Independent"} · {grant.grantedAt ? `since ${formatDateTime(grant.grantedAt)}` : "pending acceptance"}</div></div>
                  <div className="row"><Badge value={grant.status} />{grant.status !== "revoked" ? (
                    <form action={revokeAdvisorAction}><input type="hidden" name="returnTo" value="/app/team" /><input type="hidden" name="accessId" value={grant.id} /><button className="btn small danger" type="submit">Revoke</button></form>
                  ) : null}</div>
                </li>
              ))}</ul>
            )}
          </div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "team");
  }
}
