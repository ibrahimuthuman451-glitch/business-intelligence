import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfiles, organizations, subscriptionEntitlements } from "@/db/schema";
import { requirePageContext } from "@/lib/current-user";
import { formatDate } from "@/lib/format";
import { Alert, Badge, PageHeader } from "@/components/ui";
import { changePasswordAction, updateProfileAction } from "../actions";
import { serviceUnavailable } from "@/lib/page-guards";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const params = await searchParams;
  const { org, actor } = await requirePageContext("org:read");
  const canManage = org.permissions.includes("org:manage");
  try {
    const db = getDb();
    const [profile] = await db.select().from(businessProfiles).where(eq(businessProfiles.orgId, org.orgId)).limit(1);
    const [organization] = await db.select().from(organizations).where(eq(organizations.id, org.orgId)).limit(1);
    const entitlements = await db.select().from(subscriptionEntitlements).where(eq(subscriptionEntitlements.orgId, org.orgId));
    return (
      <>
        <PageHeader eyebrow={org.orgName} title="Settings" description="Business profile, tender matching signals and account security." />
        {params.ok ? <Alert tone="success">{params.ok}</Alert> : null}
        {params.error ? <Alert tone="error">{params.error}</Alert> : null}
        <div className="grid grid-2 section">
          <div className="card">
            <div className="card-head"><h2>Business profile</h2></div>
            <form action={updateProfileAction} className="card-pad">
              <input type="hidden" name="returnTo" value="/app/settings" />
              <div className="form-grid">
                <div className="field"><label htmlFor="organizationName">Display name</label><input id="organizationName" name="organizationName" defaultValue={organization?.name ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="legalName">Legal name</label><input id="legalName" name="legalName" defaultValue={profile?.legalName ?? ""} required disabled={!canManage} /></div>
                <div className="field"><label htmlFor="tradingName">Trading name</label><input id="tradingName" name="tradingName" defaultValue={profile?.tradingName ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="tin">TIN</label><input id="tin" name="tin" defaultValue={profile?.tin ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="registrationNumber">Registration number</label><input id="registrationNumber" name="registrationNumber" defaultValue={profile?.registrationNumber ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="sector">Sector</label><input id="sector" name="sector" defaultValue={profile?.sector ?? ""} placeholder="construction" disabled={!canManage} /></div>
                <div className="field"><label htmlFor="city">City</label><input id="city" name="city" defaultValue={profile?.city ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="countryCode">Country</label><input id="countryCode" name="countryCode" defaultValue={profile?.countryCode ?? "RW"} maxLength={2} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="contactEmail">Contact email</label><input id="contactEmail" name="contactEmail" type="email" defaultValue={profile?.contactEmail ?? ""} disabled={!canManage} /></div>
                <div className="field"><label htmlFor="contactPhone">Contact phone</label><input id="contactPhone" name="contactPhone" defaultValue={profile?.contactPhone ?? ""} disabled={!canManage} /></div>
              </div>
              <div className="field"><label htmlFor="keywords">Tender keywords</label><input id="keywords" name="keywords" defaultValue={(profile?.keywords ?? []).join(", ")} placeholder="roads, drainage, consulting" disabled={!canManage} /><span className="hint">Comma-separated. Used only to score relevance, never to decide eligibility.</span></div>
              <div className="field"><label htmlFor="address">Address</label><textarea id="address" name="address" defaultValue={profile?.address ?? ""} disabled={!canManage} /></div>
              {canManage ? <button className="btn accent" type="submit">Save profile</button> : <p className="tiny muted mb-0">Only an owner can edit the profile.</p>}
            </form>
          </div>
          <div className="stack">
            <div className="card">
              <div className="card-head"><h2>Account</h2></div>
              <div className="card-pad">
                <dl className="kv">
                  <dt>Name</dt><dd>{actor.user.name}</dd>
                  <dt>Email</dt><dd>{actor.user.email} {actor.user.emailVerifiedAt ? <Badge value="approved" label="verified" /> : <Badge value="pending" />}</dd>
                  <dt>Organization currency</dt><dd>{organization?.defaultCurrency ?? "RWF"}</dd>
                  <dt>Organization type</dt><dd>{organization?.kind ?? "business"}</dd>
                  <dt>Member since</dt><dd>{formatDate(organization?.createdAt)}</dd>
                </dl>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Change password</h2></div>
              <form action={changePasswordAction} className="card-pad">
                <input type="hidden" name="returnTo" value="/app/settings" />
                <div className="field"><label htmlFor="currentPassword">Current password</label><input id="currentPassword" name="currentPassword" type="password" required autoComplete="current-password" /></div>
                <div className="field"><label htmlFor="newPassword">New password</label><input id="newPassword" name="newPassword" type="password" required minLength={12} autoComplete="new-password" /></div>
                <button className="btn secondary" type="submit">Update password</button>
              </form>
            </div>
            <div className="card">
              <div className="card-head"><h2>Plan entitlements</h2></div>
              <ul className="list card-pad">{entitlements.map((entitlement) => (
                <li key={entitlement.id} className="row-between"><span className="small strong">{entitlement.feature.replace("_", " ")}</span><span className="row">{entitlement.limitValue != null ? <span className="tiny muted">limit {entitlement.limitValue}</span> : null}<Badge value={entitlement.enabled ? "active" : "revoked"} label={entitlement.enabled ? "enabled" : "disabled"} /></span></li>
              ))}</ul>
            </div>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return serviceUnavailable(error, "settings");
  }
}
