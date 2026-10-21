import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { authorizeOrg } from "@/lib/authz";
import { getCurrentActor, resolveActiveOrg } from "@/lib/current-user";
import { toErrorResponse, ValidationError } from "@/lib/errors";
import { parseTabularFile, suggestMapping } from "@/lib/reconciliation";
import { maxUploadBytes } from "@/lib/storage";

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (origin) {
      const expected = new URL(request.url).origin;
      if (origin !== expected) throw new ValidationError("Cross-origin request rejected");
    }
    const actor = await getCurrentActor();
    if (!actor) return Response.json({ error: "Not signed in" }, { status: 401 });
    const base = await resolveActiveOrg(actor);
    if (!base) return Response.json({ error: "No organization access" }, { status: 403 });
    const org = await authorizeOrg(getDb(), actor, base.orgId, "recon:write");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError("Choose a CSV or XLSX file");
    }
    if (file.size > maxUploadBytes()) {
      throw new ValidationError(`File is too large. Maximum ${Math.floor(maxUploadBytes() / 1048576)} MB`);
    }
    const table = await parseTabularFile({
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return Response.json({
      headers: table.headers,
      format: table.format,
      rows: table.rows.length,
      suggestion: suggestMapping(table.headers),
      org: org.orgId,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
