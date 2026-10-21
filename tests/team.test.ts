import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { advisorAccess, memberships } from "@/db/schema";
import { authorizeOrg } from "@/lib/authz";
import { authenticate } from "@/lib/auth";
import {
  acceptInvitationForUser,
  createMemberInvitation,
  grantAdvisorAccess,
  registerInvitedUser,
  revokeAdvisorAccess,
} from "@/lib/team";
import {
  createOrg,
  createTestContext,
  makePlatformAdmin,
  reloadActor,
  TEST_PASSWORD,
  type TestContext,
} from "./helpers";
import { ForbiddenError, ValidationError } from "@/lib/errors";

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("member invitations", () => {
  it("creates a staff membership only after the invited user accepts", async () => {
    const owner = await createOrg(context.db, { email: "invite-owner@example.com", orgName: "Invite Co" });
    const invitation = await createMemberInvitation(context.db, owner.ctx, {
      email: "new-staff@example.com",
      role: "staff",
    });

    expect(
      await context.db.select().from(memberships).where(eq(memberships.orgId, owner.orgId)),
    ).toHaveLength(1);

    const registered = await registerInvitedUser(context.db, invitation.token, {
      name: "New Staff",
      password: TEST_PASSWORD,
    });
    expect(registered.orgId).toBe(owner.orgId);
    const user = await authenticate(context.db, "new-staff@example.com", TEST_PASSWORD);
    expect(user.id).toBe(registered.userId);

    const staffCtx = await authorizeOrg(
      context.db,
      await reloadActor(context.db, registered.userId),
      owner.orgId,
      "finance:read",
    );
    expect(staffCtx.role).toBe("staff");
    expect(staffCtx.permissions).not.toContain("team:manage");
    await expect(
      createMemberInvitation(context.db, staffCtx, { email: "another@example.com", role: "staff" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses acceptance from a different email address", async () => {
    const owner = await createOrg(context.db, { email: "mismatch-owner@example.com", orgName: "Mismatch Co" });
    const invitation = await createMemberInvitation(context.db, owner.ctx, {
      email: "intended@example.com",
      role: "staff",
    });
    const other = await createOrg(context.db, { email: "other@example.com", orgName: "Other Co" });
    await expect(
      acceptInvitationForUser(context.db, invitation.token, other.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await context.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, owner.orgId), eq(memberships.userId, other.userId))),
    ).toHaveLength(0);
  });
});

describe("advisor authorization", () => {
  it("requires an active client grant and stops working immediately after revocation", async () => {
    const client = await createOrg(context.db, { email: "advisor-client@example.com", orgName: "Advisor Client" });
    const advisor = await createOrg(context.db, {
      email: "advisor@firm.example",
      orgName: "Advisory Firm",
      kind: "accounting_firm",
    });

    const grant = await grantAdvisorAccess(context.db, client.ctx, {
      advisorEmail: advisor.email,
    });

    // Pending: the advisor must not see anything yet.
    await expect(
      authorizeOrg(context.db, await reloadActor(context.db, advisor.userId), client.orgId, "finance:read"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await acceptInvitationForUser(context.db, grant.token, advisor.userId);
    const advisorCtx = await authorizeOrg(
      context.db,
      await reloadActor(context.db, advisor.userId),
      client.orgId,
      "finance:read",
    );
    expect(advisorCtx.role).toBe("advisor");
    expect(advisorCtx.viaAdvisorAccess).toBe(true);
    expect(advisorCtx.permissions).toContain("documents:review");
    expect(advisorCtx.permissions).not.toContain("team:manage");

    // Advisor access must not masquerade as a membership, or revocation would leak.
    const membershipRows = await context.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, client.orgId), eq(memberships.userId, advisor.userId)));
    expect(membershipRows).toHaveLength(0);

    await revokeAdvisorAccess(context.db, client.ctx, grant.id);
    await expect(
      authorizeOrg(context.db, await reloadActor(context.db, advisor.userId), client.orgId, "finance:read"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const [row] = await context.db.select().from(advisorAccess).where(eq(advisorAccess.id, grant.id));
    expect(row?.status).toBe("revoked");
    expect(row?.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects an advisor invitation used by a different account", async () => {
    const client = await createOrg(context.db, { email: "advisor2-client@example.com", orgName: "Advisor2 Client" });
    const advisor = await createOrg(context.db, { email: "advisor2@firm.example", orgName: "Advisor2 Firm", kind: "accounting_firm" });
    const other = await createOrg(context.db, { email: "advisor2-other@example.com", orgName: "Other Advisor" });
    const grant = await grantAdvisorAccess(context.db, client.ctx, { advisorEmail: advisor.email });
    await expect(
      acceptInvitationForUser(context.db, grant.token, other.userId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses grants created by a non-manager", async () => {
    const client = await createOrg(context.db, { email: "advisor3-client@example.com", orgName: "Advisor3 Client" });
    const staff = await createOrg(context.db, { email: "advisor3-staff@example.com", orgName: "Staff Co" });
    await context.db.insert(memberships).values({
      orgId: client.orgId,
      userId: staff.userId,
      role: "staff",
      status: "active",
    });
    const staffCtx = await authorizeOrg(
      context.db,
      await reloadActor(context.db, staff.userId),
      client.orgId,
      "finance:read",
    );
    await expect(
      grantAdvisorAccess(context.db, staffCtx, { advisorEmail: "someone@example.com" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("does not give a platform administrator implicit tenant access", async () => {
    const tenant = await createOrg(context.db, { email: "platform-tenant@example.com", orgName: "Platform Tenant" });
    const admin = await createOrg(context.db, { email: "platform-admin@example.com", orgName: "Platform Admin Org" });
    await makePlatformAdmin(context.db, admin.userId);
    const adminActor = await reloadActor(context.db, admin.userId);
    expect(adminActor.user.isPlatformAdmin).toBe(true);
    await expect(
      authorizeOrg(context.db, adminActor, tenant.orgId, "finance:read"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      authorizeOrg(context.db, adminActor, tenant.orgId, "org:read"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects expired invitation tokens", async () => {
    const owner = await createOrg(context.db, { email: "expired-owner@example.com", orgName: "Expired Co" });
    const invitation = await createMemberInvitation(context.db, owner.ctx, {
      email: "late@example.com",
      role: "staff",
    });
    const { invitations } = await import("@/db/schema");
    await context.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invitation.id));
    await expect(
      registerInvitedUser(context.db, invitation.token, { name: "Late User", password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
