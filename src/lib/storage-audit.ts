import type { AppDb } from "@/db/client";
import { documents } from "@/db/schema";
import { listStoredObjects, storageDriverName } from "./storage";

export type StorageAudit = {
  driver: string;
  objects: number;
  referenced: number;
  orphanedObjects: { key: string; sizeBytes: number }[];
  missingObjects: { documentId: string; storageKey: string }[];
};

/**
 * Compares object storage with document rows. Only lists objects when the
 * driver supports enumeration (local or S3). Never deletes anything.
 */
export async function auditStorage(db: AppDb): Promise<StorageAudit> {
  const rows = await db.select({ id: documents.id, storageKey: documents.storageKey }).from(documents);
  const objects = await listStoredObjects();
  const objectKeys = new Set(objects.map((object) => object.key));
  const referencedKeys = new Set(rows.map((row) => row.storageKey));
  return {
    driver: storageDriverName(),
    objects: objects.length,
    referenced: rows.length,
    orphanedObjects: objects.filter((object) => !referencedKeys.has(object.key)),
    missingObjects: rows
      .filter((row) => !objectKeys.has(row.storageKey))
      .map((row) => ({ documentId: row.id, storageKey: row.storageKey })),
  };
}
