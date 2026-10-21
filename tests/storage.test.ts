import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { eq } from "drizzle-orm";
import { documents } from "@/db/schema";
import { createOrg, createTestContext, type TestContext } from "./helpers";
import {
  getStorageDriver,
  setStorageDriverForTesting,
  storageDriverName,
  uploadRoot,
  type StorageDriver,
} from "@/lib/storage";
import { ClamAvScanner, scanUpload, setScannerForTesting } from "@/lib/malware";
import { createDocument, readAuthorizedDocument } from "@/lib/documents";
import { auditStorage } from "@/lib/storage-audit";
import { GET as downloadDocument } from "@/app/api/documents/[id]/download/route";
import { NextRequest } from "next/server";
import { createSession } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { existsSync } from "node:fs";
import path from "node:path";

let context: TestContext;
const cleanPdf = Buffer.from("%PDF-1.4\nclean document\n%%EOF\n");
const eicarPdf = Buffer.from("%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF\n");

beforeAll(async () => {
  context = await createTestContext();
});

afterEach(() => {
  setScannerForTesting(null);
  setStorageDriverForTesting(null);
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  delete process.env.STORAGE_DRIVER;
  delete process.env.VERCEL;
});

afterAll(async () => {
  await context.cleanup();
});

class MemoryDriver implements StorageDriver {
  readonly name = "memory";
  objects = new Map<string, Buffer>();
  puts = 0;
  deletes = 0;
  failPut = false;
  async put(key: string, bytes: Buffer): Promise<void> {
    this.puts += 1;
    if (this.failPut) throw new AppError("Synthetic storage failure", 502, "storage_unavailable");
    this.objects.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new AppError("The stored file is unavailable", 404, "document_missing");
    return Buffer.from(value);
  }
  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, sizeBytes: value.length }));
  }
}

async function fakeClamAv(detectsEicar: boolean): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let streaming = false;
    let payload = Buffer.alloc(0);
    let commandSeen = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (!commandSeen && buffer.includes(0)) {
        commandSeen = true;
        buffer = buffer.subarray(buffer.indexOf(0) + 1);
        streaming = true;
      }
      while (streaming && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const infected = detectsEicar && payload.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
          socket.write(infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          streaming = false;
          break;
        }
        if (buffer.length < 4 + length) break;
        payload = Buffer.concat([payload, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

async function useClamAv(port: number) {
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(port);
}

describe("storage abstraction", () => {
  it("stores, reads and deletes through an injected private driver", async () => {
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    expect(storageDriverName()).toBe("local");
    const org = await createOrg(context.db, { email: "driver@example.com", orgName: "Driver Co" });
    const created = await createDocument(context.db, org.ctx, {
      filename: "driver.pdf",
      bytes: cleanPdf,
    });
    const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
    const key = row!.storageKey;
    expect(driver.objects.has(key)).toBe(true);
    expect(driver.objects.get(key)!.equals(cleanPdf)).toBe(true);
    expect(existsSync(path.join(uploadRoot(), key))).toBe(false);

    const read = await readAuthorizedDocument(context.db, org.ctx, created.id);
    expect(read.bytes.equals(cleanPdf)).toBe(true);
    expect(row?.scanStatus).toBe("not_scanned");
  });

  it("removes the stored object when the database insert is rejected by quota", async () => {
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "driver-quota@example.com", orgName: "Driver Quota" });
    const { subscriptionEntitlements } = await import("@/db/schema");
    await context.db
      .insert(subscriptionEntitlements)
      .values({ orgId: org.orgId, feature: "documents_count", enabled: true, limitValue: 0 });
    await expect(
      createDocument(context.db, org.ctx, { filename: "blocked.pdf", bytes: cleanPdf }),
    ).rejects.toMatchObject({ code: "entitlement_limit" });
    expect(driver.objects.size).toBe(0);
    expect(driver.deletes).toBeGreaterThanOrEqual(1);
  });

  it("does not keep a database row when the storage write fails", async () => {
    const driver = new MemoryDriver();
    driver.failPut = true;
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "driver-fail@example.com", orgName: "Driver Fail" });
    await expect(
      createDocument(context.db, org.ctx, { filename: "fail.pdf", bytes: cleanPdf }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    const rows = await context.db.select().from(documents).where(eq(documents.orgId, org.orgId));
    expect(rows).toHaveLength(0);
  });

  it("refuses ephemeral local storage on Vercel", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    expect(() => getStorageDriver()).toThrow(/requires STORAGE_DRIVER=s3/i);
  });

  it("requires explicit S3 configuration instead of falling back silently", () => {
    process.env.STORAGE_DRIVER = "s3";
    expect(() => getStorageDriver()).toThrow(/not configured/i);
  });

  it("reports orphaned objects without deleting them", async () => {
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "audit-driver@example.com", orgName: "Audit Driver" });
    await createDocument(context.db, org.ctx, { filename: "known.pdf", bytes: cleanPdf });
    await driver.put(`${org.orgId}/orphan.pdf`, Buffer.from("orphan"));
    const report = await auditStorage(context.db);
    expect(report.orphanedObjects.map((object) => object.key)).toContain(`${org.orgId}/orphan.pdf`);
    expect(driver.objects.has(`${org.orgId}/orphan.pdf`)).toBe(true);
  });
});

describe("malware scanning", () => {
  it("speaks ClamAV INSTREAM and detects a test signature", async () => {
    const fake = await fakeClamAv(true);
    try {
      const scanner = new ClamAvScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 3000 });
      const clean = await scanner.scan(cleanPdf, "clean.pdf");
      expect(clean.status).toBe("clean");
      const infected = await scanner.scan(eicarPdf, "eicar.pdf");
      expect(infected.status).toBe("infected");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("rejects an infected upload and never persists it", async () => {
    const fake = await fakeClamAv(true);
    await useClamAv(fake.port);
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "infected@example.com", orgName: "Infected Co" });
    try {
      await expect(
        createDocument(context.db, org.ctx, { filename: "malware.pdf", bytes: eicarPdf }),
      ).rejects.toMatchObject({ code: "malware_detected" });
      expect(driver.objects.size).toBe(0);
      const rows = await context.db.select().from(documents).where(eq(documents.orgId, org.orgId));
      expect(rows).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("stores clean uploads with a clean scan result", async () => {
    const fake = await fakeClamAv(true);
    await useClamAv(fake.port);
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "clean-scan@example.com", orgName: "Clean Scan" });
    try {
      const created = await createDocument(context.db, org.ctx, {
        filename: "clean.pdf",
        bytes: cleanPdf,
      });
      const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
      expect(row?.scanStatus).toBe("clean");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("fails closed when the configured scanner is unavailable", async () => {
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = "9";
    await expect(scanUpload(cleanPdf, "clean.pdf")).rejects.toMatchObject({
      code: "malware_scan_unavailable",
    });
  });

  it("blocks downloads of a quarantined row even if bytes still exist", async () => {
    const driver = new MemoryDriver();
    setStorageDriverForTesting(driver);
    const org = await createOrg(context.db, { email: "quarantine@example.com", orgName: "Quarantine Co" });
    const created = await createDocument(context.db, org.ctx, {
      filename: "quarantine.pdf",
      bytes: cleanPdf,
    });
    await context.db
      .update(documents)
      .set({ scanStatus: "infected", quarantinedAt: new Date() })
      .where(eq(documents.id, created.id));
    await expect(readAuthorizedDocument(context.db, org.ctx, created.id)).rejects.toMatchObject({
      status: 403,
    });

    const session = await createSession(context.db, org.userId);
    const response = await downloadDocument(
      new NextRequest(`http://localhost:3000/api/documents/${created.id}/download`, {
        headers: { cookie: `bi_session=${session.token}` },
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(response.status).toBe(403);
  });
});
