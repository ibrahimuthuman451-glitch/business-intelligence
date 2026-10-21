/**
 * Seeds a clearly-labelled demo workspace with sample data.
 * Safe to re-run: it exits early if the demo account already exists.
 */
import { getDb, closeDb } from "../src/db/client";
import { seedDemoWorkspace } from "../src/db/seed-demo";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_DEMO_DATA !== "true") {
    throw new Error("Refusing to seed demo data in production. Set SEED_DEMO_DATA=true to override.");
  }
  const result = await seedDemoWorkspace(getDb());
  if (!result.created) {
    console.log("Demo workspace already exists; nothing to do. Use npm run demo:reset to restore it.");
    return;
  }
  console.log("Demo workspace seeded with fictional sample data.");
  console.log(`  Business owner: ${result.ownerEmail} / ${result.password}`);
  console.log(`  Advisor:        ${result.advisorEmail} / ${result.password}`);
  console.log("  Every record is labelled SAMPLE. Sample tenders are not real notices.");
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch((error) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
