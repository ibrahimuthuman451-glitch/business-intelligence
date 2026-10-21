import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailTransportMode, isEmailConfigured } from "@/lib/email";
import { emailOutboxStatus } from "@/lib/email/outbox";
import { scannerConfigured } from "@/lib/malware";
import { mfaEncryptionConfigured } from "@/lib/mfa/crypto";
import { mfaRequiredRoles } from "@/lib/mfa/policy";
import { storageDriverName } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const email = await emailOutboxStatus(db);
    return Response.json({
      status: "ok",
      database: "reachable",
      storage: storageDriverName(),
      malwareScanner: scannerConfigured() ? "configured" : "not_configured",
      mfa: {
        encryptionConfigured: mfaEncryptionConfigured(),
        requiredRoles: [...mfaRequiredRoles()],
      },
      email: {
        transport: emailTransportMode(),
        configured: isEmailConfigured(),
        queued: email.queued,
        failed: email.failed,
      },
      time: new Date().toISOString(),
    });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
