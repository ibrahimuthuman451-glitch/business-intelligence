import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { organizations } from "@/db/schema";
import { actorFromRequest, activeOrgFromRequest } from "@/lib/request-auth";
import { authorizeOrg } from "@/lib/authz";
import { assertEntitlement } from "@/lib/entitlements";
import { buildReport, type ReportType } from "@/lib/reports";
import { recordAuditSafe } from "@/lib/audit";
import { toErrorResponse, ValidationError } from "@/lib/errors";

const TYPES = new Set<ReportType>(["sales", "invoices", "tasks"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ type: string }> },
) {
  try {
    const { type } = await context.params;
    if (!TYPES.has(type as ReportType)) throw new ValidationError("Unknown report type");
    const actor = await actorFromRequest(request);
    if (!actor) return Response.json({ error: "Not signed in" }, { status: 401 });

    const db = getDb();
    const preferred = activeOrgFromRequest(request);
    const orgId = preferred ?? actor.memberships[0]?.orgId;
    if (!orgId || !actor.memberships.some((membership) => membership.orgId === orgId)) {
      return Response.json({ error: "No organization access" }, { status: 403 });
    }
    const org = await authorizeOrg(db, actor, orgId, "finance:read");
    await assertEntitlement(db, orgId, "advanced_exports");

    const report = await buildReport(db, org, type as ReportType);
    const [organization] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    await recordAuditSafe(db, {
      orgId,
      actorUserId: actor.user.id,
      actorEmail: actor.user.email,
      action: "report.exported",
      entityType: "report",
      entityId: type,
      metadata: { filename: report.filename },
    });

    return new Response(report.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${report.filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Report-Organization": organization?.name ?? "",
        "X-Report-Sample": org.plan === "demo" ? "true" : "false",
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status: status === 402 ? 402 : status });
  }
}

