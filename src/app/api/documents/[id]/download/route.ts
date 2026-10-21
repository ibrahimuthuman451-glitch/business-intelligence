import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { documents } from "@/db/schema";
import { authorizeOrg } from "@/lib/authz";
import { getCurrentActor } from "@/lib/current-user";
import { readAuthorizedDocument } from "@/lib/documents";
import { toErrorResponse } from "@/lib/errors";

/**
 * Private document delivery. The document's own organization is authorized
 * against the signed-in actor, not the active-organization cookie, so a crafted
 * id can never cross tenants.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const actor = await getCurrentActor();
    if (!actor) {
      return Response.json({ error: "Sign in to download this document" }, { status: 401 });
    }
    const db = getDb();
    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    // Do not reveal whether another tenant's document exists.
    if (!row) return Response.json({ error: "Document not found" }, { status: 404 });
    const org = await authorizeOrg(db, actor, row.orgId, "documents:read");
    const file = await readAuthorizedDocument(db, org, id, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    const asciiName = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
