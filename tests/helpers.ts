import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
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

type GlobalWithDb = { __biDb?: { db?: AppDb; client?: PGlite } };

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

export type TestContext = {
  db: AppDb;
  client: PGlite;
  uploadDir: string;
  cleanup: () => Promise<void>;
};

export async function createTestContext(): Promise<TestContext> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as AppDb;
  await migrate(db as never, { migrationsFolder });

  const uploadDir = mkdtempSync(path.join(tmpdir(), "bi-docs-"));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.MAX_UPLOAD_BYTES = String(2 * 1024 * 1024);
  delete process.env.DATABASE_URL;

  // Route handlers call getDb(); point the process-wide handle at this test DB.
  (globalThis as unknown as GlobalWithDb).__biDb = { db, client };

  return {
    db,
    client,
    uploadDir,
    cleanup: async () => {
      await client.close();
      (globalThis as unknown as GlobalWithDb).__biDb = undefined;
      rmSync(uploadDir, { recursive: true, force: true });
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
