import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/client";
import * as schema from "@/db/schema";
import { users } from "@/db/schema";
import { registerUser, verifyEmail } from "@/lib/auth";
import { authorizeOrg, loadActor, type Actor, type OrgContext } from "@/lib/authz";

export const TEST_PASSWORD = "CorrectHorse9!";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

type GlobalWithDb = { __biDb?: { db?: AppDb; client?: unknown } };

export type TestContext = {
  db: AppDb;
  driver: "pglite" | "postgres";
  uploadDir: string;
  cleanup: () => Promise<void>;
};

let pgCounter = 0;

/**
 * Creates an isolated database for a test file.
 *
 * - Default: in-memory PGlite (fast, no external service).
 * - TEST_DATABASE_URL: creates and migrates a throwaway PostgreSQL database,
 *   so the exact same suites can prove PostgreSQL compatibility.
 */
export async function createTestContext(): Promise<TestContext> {
  const uploadDir = mkdtempSync(path.join(tmpdir(), "bi-docs-"));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.MAX_UPLOAD_BYTES = String(2 * 1024 * 1024);

  const pgAdminUrl = process.env.TEST_DATABASE_URL;
  const context = pgAdminUrl ? await createPostgresContext(pgAdminUrl) : await createPgliteContext();
  return {
    ...context,
    uploadDir,
    cleanup: async () => {
      await context.cleanup();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

async function createPgliteContext(): Promise<Omit<TestContext, "uploadDir" | "cleanup"> & { cleanup: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema }) as unknown as AppDb;
  await migratePglite(db as never, { migrationsFolder });
  (globalThis as unknown as GlobalWithDb).__biDb = { db, client };
  return {
    db,
    driver: "pglite",
    cleanup: async () => {
      await client.close();
      (globalThis as unknown as GlobalWithDb).__biDb = undefined;
    },
  };
}

async function createPostgresContext(
  adminUrl: string,
): Promise<Omit<TestContext, "uploadDir" | "cleanup"> & { cleanup: () => Promise<void> }> {
  const base = new URL(adminUrl);
  const databaseName = `bi_test_${process.pid}_${Date.now()}_${(pgCounter += 1)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${databaseName}"`);

  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const client = postgres(target.toString(), { max: 5, onnotice: () => {} });
  const db = drizzlePostgres(client, { schema }) as unknown as AppDb;

  try {
    await migratePostgres(db as never, { migrationsFolder });
  } catch (error) {
    await client.end().catch(() => undefined);
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }

  (globalThis as unknown as GlobalWithDb).__biDb = { db, client };
  return {
    db,
    driver: "postgres",
    cleanup: async () => {
      (globalThis as unknown as GlobalWithDb).__biDb = undefined;
      await client.end().catch(() => undefined);
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

export type TestOrg = {
  userId: string;
  orgId: string;
  email: string;
  actor: Actor;
  ctx: OrgContext;
};

export async function createOrg(
  db: AppDb,
  input: {
    email: string;
    orgName?: string;
    kind?: "business" | "accounting_firm";
    verified?: boolean;
  },
): Promise<TestOrg> {
  const result = await registerUser(db, {
    name: input.orgName ?? "Test User",
    email: input.email,
    password: TEST_PASSWORD,
    organizationName: input.orgName ?? `Org ${input.email}`,
    organizationKind: input.kind ?? "business",
  });
  if (input.verified !== false) {
    await verifyEmail(db, result.emailVerificationToken);
  }
  const actor = await loadActor(db, result.userId);
  if (!actor) throw new Error("actor not created");
  const ctx = await authorizeOrg(db, actor, result.organizationId, "org:read");
  return {
    userId: result.userId,
    orgId: result.organizationId,
    email: input.email,
    actor,
    ctx,
  };
}

export async function reloadActor(db: AppDb, userId: string): Promise<Actor> {
  const actor = await loadActor(db, userId);
  if (!actor) throw new Error("actor missing");
  return actor;
}

export async function makePlatformAdmin(db: AppDb, userId: string): Promise<void> {
  await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, userId));
}
