/** Read-only comparison of private storage and document rows. */
import { closeDb, getDb } from "../src/db/client";
import { auditStorage } from "../src/lib/storage-audit";

async function main() {
  const audit = await auditStorage(getDb());
  console.log(JSON.stringify(audit, null, 2));
  if (audit.orphanedObjects.length > 0) {
    console.log("Orphaned objects are not deleted automatically. Review retention policy first.");
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Storage audit failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
