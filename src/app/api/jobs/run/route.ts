import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db/client";
import { runScheduledJobs } from "@/lib/jobs";
import { toErrorResponse } from "@/lib/errors";

function authorised(request: NextRequest): boolean {
  const secret = process.env.JOBS_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Scheduler entry point. Disabled (404) unless JOBS_SECRET is configured.
 * Never exposed to end users; no debug output or secrets are returned.
 */
export async function POST(request: NextRequest) {
  if (!process.env.JOBS_SECRET) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runScheduledJobs(getDb());
    return Response.json({ status: "ok", runId: result.runId, summary: result.summary });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status: status === 400 ? 500 : status });
  }
}
