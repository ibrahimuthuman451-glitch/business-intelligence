import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { resolveSession } from "./auth";
import { loadActor, type Actor } from "./authz";
import { ACTIVE_ORG_COOKIE, SESSION_COOKIE } from "./session-cookie";

function cookieValue(request: NextRequest, name: string): string | undefined {
  const fromRequest = request.cookies.get(name)?.value;
  if (fromRequest) return fromRequest;
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Resolves the signed-in actor from the request itself (not global cookies), for API routes and tests. */
export async function actorFromRequest(request: NextRequest): Promise<Actor | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const db = getDb();
  const user = await resolveSession(db, token);
  if (!user) return null;
  return loadActor(db, user.id);
}

export function activeOrgFromRequest(request: NextRequest): string | undefined {
  return cookieValue(request, ACTIVE_ORG_COOKIE);
}

export { SESSION_COOKIE, ACTIVE_ORG_COOKIE };
