/** Restores only the demo workspace. Real customer organizations are never touched. */
import { closeDb, getDb } from "../src/db/client";
import { seedDemoWorkspace } from "../src/db/seed-demo";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_DEMO_DATA !== "true") {
    throw new Error("Refusing to reset demo data in production. Set SEED_DEMO_DATA=true to override.");
  }
  const db = getDb();
  const result = await seedDemoWorkspace(db, { reset: true });
  console.log("Demo workspace restored.");
  console.log(`  Business owner: ${result.ownerEmail} / ${result.password}`);
  console.log(`  Advisor:        ${result.advisorEmail} / ${result.password}`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch((error) => {
    console.error("Demo reset failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
