/** Runs reminders and email retries once. Configure cron/systemd to invoke this. */
import { closeDb, getDb } from "../src/db/client";
import { runScheduledJobs } from "../src/lib/jobs";
import { emailTransportMode } from "../src/lib/email";

async function main() {
  const result = await runScheduledJobs(getDb());
  console.log(JSON.stringify({ runId: result.runId, emailTransport: emailTransportMode(), ...result.summary }, null, 2));
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Job run failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
