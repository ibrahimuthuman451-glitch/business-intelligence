import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { mkdirSync } from "node:fs";
import * as schema from "./schema";

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

type GlobalDb = {
  db?: AppDb;
  client?: PGlite;
};

const globalForDb = globalThis as unknown as { __biDb?: GlobalDb };

export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : undefined;
}

/**
 * Returns the process-wide database handle.
 *
 * - With DATABASE_URL set, uses PostgreSQL (production).
 * - Otherwise uses an embedded PGlite instance for local development/tests.
 *   PGlite is PostgreSQL compiled to WASM, so SQL and migrations are compatible.
 */
export function getDb(): AppDb {
  if (globalForDb.__biDb?.db) return globalForDb.__biDb.db;

  const url = databaseUrl();
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production; refusing to use embedded PGlite");
  }
  if (url) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema }) as unknown as AppDb;
    globalForDb.__biDb = { db };
    return db;
  }

  const dir = process.env.PGLITE_DIR ?? ".data/pglite";
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema }) as unknown as AppDb;
  globalForDb.__biDb = { db, client };
  return db;
}

export async function closeDb(): Promise<void> {
  await globalForDb.__biDb?.client?.close();
  globalForDb.__biDb = undefined;
}

export { schema };
