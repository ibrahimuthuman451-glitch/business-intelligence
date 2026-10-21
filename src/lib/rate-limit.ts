import { and, eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import { rateLimits } from "@/db/schema";

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: Date;
};

/**
 * Atomic fixed-window limiter. The upsert increments the counter in one
 * statement, so concurrent requests cannot both observe a stale count.
 */
export async function consumeRateLimit(
  db: AppDb,
  input: { bucket: string; key: string; limit: number; windowSeconds: number; now?: Date },
): Promise<RateLimitResult> {
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  const [row] = await db
    .insert(rateLimits)
    .values({ bucket: input.bucket, key: input.key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  const count = row?.count ?? 1;
  return { allowed: count <= input.limit, count, limit: input.limit, resetAt };
}

/** Opportunistic cleanup invoked by scheduled jobs. */
export async function pruneRateLimits(db: AppDb, olderThanDays = 2): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const deleted = await db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff)).returning({
    bucket: rateLimits.bucket,
  });
  return deleted.length;
}

export async function currentRateLimit(
  db: AppDb,
  input: { bucket: string; key: string; windowSeconds: number; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.bucket, input.bucket),
        eq(rateLimits.key, input.key),
        eq(rateLimits.windowStart, windowStart),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}
