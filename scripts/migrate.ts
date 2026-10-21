/**
 * Applies SQL migrations from /drizzle to the configured database.
 * Works with PostgreSQL (DATABASE_URL) and embedded PGlite (dev/test).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import path from "node:path";
import { mkdirSync } from "node:fs";

const folder = path.resolve(process.cwd(), "drizzle");
const url = process.env.DATABASE_URL?.trim();

async function main() {
  if (url) {
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema });
    await migratePostgres(db, { migrationsFolder: folder });
    await client.end();
    console.log(`Migrations applied to PostgreSQL at ${new URL(url).host}`);
    return;
  }

  const dir = path.resolve(process.cwd(), process.env.PGLITE_DIR ?? ".data/pglite");
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: folder });
  await client.close();
  console.log(`Migrations applied to embedded PGlite at ${dir}`);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
