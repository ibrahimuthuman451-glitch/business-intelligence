/** Verifies a real ClamAV daemon detects EICAR and passes a clean PDF. */
import { getScanner, scannerConfigured } from "../src/lib/malware";

async function main() {
  if (!scannerConfigured()) throw new Error("Set CLAMAV_HOST and CLAMAV_PORT");
  const scanner = getScanner();
  const eicar = Buffer.from(
    "%PDF-1.4\n" +
      Buffer.from(
        "58354f2150254041505b345c505a58353428505e2937434329377d2445494341522d5354414e444152442d414e544956495255532d544553542d46494c452124482b482a",
        "hex",
      ).toString() +
      "\n%%EOF",
  );
  const infected = await scanner.scan(eicar, "eicar.pdf");
  const clean = await scanner.scan(Buffer.from("%PDF-1.4\nstaging clean\n%%EOF"), "clean.pdf");
  if (infected.status !== "infected") {
    throw new Error(`ClamAV did not detect the EICAR test signature (got ${infected.status}: ${infected.detail})`);
  }
  if (clean.status !== "clean") throw new Error(`Clean file scan returned ${clean.status}: ${clean.detail}`);
  console.log(JSON.stringify({ status: "ok", scanner: scanner.name, eicar: infected.status, clean: clean.status }));
}

main().catch((error) => {
  console.error("ClamAV verification failed:", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
