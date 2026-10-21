import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError, ValidationError } from "./errors";

export const ALLOWED_DOCUMENT_TYPES = {
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  txt: ["text/plain"],
} as const;

export type AllowedExtension = keyof typeof ALLOWED_DOCUMENT_TYPES;

export function uploadRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR ?? ".data/uploads");
}

export function maxUploadBytes(): number {
  const configured = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024);
  const value = Number.isFinite(configured) && configured > 0 ? configured : 10 * 1024 * 1024;
  // Vercel Functions cap request bodies at 4.5 MB; leave room for multipart overhead.
  return process.env.VERCEL ? Math.min(value, 4 * 1024 * 1024) : value;
}

export function extensionOf(filename: string): string {
  const clean = path.basename(filename).toLowerCase();
  const idx = clean.lastIndexOf(".");
  return idx === -1 ? "" : clean.slice(idx + 1);
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Verifies the actual file signature instead of trusting the browser MIME type. */
function signatureMatches(ext: AllowedExtension, bytes: Buffer): boolean {
  switch (ext) {
    case "pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "xlsx":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case "csv":
    case "txt":
      return !bytes.includes(0x00);
    default:
      return false;
  }
}

export type ValidatedUpload = {
  extension: AllowedExtension;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  safeFilename: string;
};

export function validateUpload(input: {
  filename: string;
  declaredMimeType?: string | null;
  bytes: Buffer;
}): ValidatedUpload {
  const safeFilename = path
    .basename(input.filename)
    .split("").filter((char) => { const code = char.charCodeAt(0); return code >= 32 && code !== 127; }).join("")
    .slice(0, 180);
  if (!safeFilename || safeFilename === "." || safeFilename === "..") {
    throw new ValidationError("A valid file name is required");
  }
  const extension = extensionOf(safeFilename) as AllowedExtension;
  if (!(extension in ALLOWED_DOCUMENT_TYPES)) {
    throw new ValidationError("Unsupported file type. Allowed: PDF, PNG, JPEG, CSV, XLSX, TXT");
  }
  if (input.bytes.length === 0) throw new ValidationError("The file is empty");
  if (input.bytes.length > maxUploadBytes()) {
    throw new ValidationError(
      `File is too large. Maximum size is ${Math.floor(maxUploadBytes() / (1024 * 1024))} MB`,
    );
  }
  if (!signatureMatches(extension, input.bytes)) {
    throw new ValidationError("The file content does not match its extension");
  }

  const expected = ALLOWED_DOCUMENT_TYPES[extension] as readonly string[];
  const declared = (input.declaredMimeType ?? "").toLowerCase();
  const mimeType = (expected.includes(declared) ? declared : expected[0]) ?? "application/octet-stream";

  return {
    extension,
    mimeType,
    sizeBytes: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    safeFilename,
  };
}

export type { StorageDriver } from "./storage-types";
import { S3StorageDriver } from "./storage-s3";
import type { StorageDriver } from "./storage-types";

function resolveKey(storageKey: string): string {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.[a-z0-9]+$/.test(storageKey)) {
    throw new AppError("Invalid storage reference", 500, "invalid_storage_key");
  }
  const root = uploadRoot();
  const target = path.resolve(root, storageKey);
  if (!target.startsWith(root + path.sep)) {
    throw new AppError("Invalid storage reference", 500, "invalid_storage_key");
  }
  return target;
}

/** Local private storage for development and single-node deployments. */
const localDriver: StorageDriver = {
  name: "local",
  async put(key, bytes) {
    const target = resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  },
  async get(key) {
    try {
      return await readFile(resolveKey(key));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("The stored file is unavailable", 404, "document_missing");
    }
  },
  async delete(key) {
    await rm(resolveKey(key), { force: true });
  },
  async list(prefix) {
    const root = uploadRoot();
    const results: { key: string; sizeBytes: number }[] = [];
    async function walk(directory: string, relative: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), nextRelative);
        else if (nextRelative.startsWith(prefix)) {
          const stat = await statFile(path.join(directory, entry.name));
          results.push({ key: nextRelative, sizeBytes: stat });
        }
      }
    }
    await walk(root, "");
    return results;
  },
};

async function statFile(target: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

let override: StorageDriver | null = null;

export function setStorageDriverForTesting(driver: StorageDriver | null): void {
  override = driver;
}

export function storageDriverName(): "local" | "s3" {
  return (process.env.STORAGE_DRIVER ?? "local").toLowerCase() === "s3" ? "s3" : "local";
}

/** Vercel/serverless filesystems are ephemeral, so local storage is refused there. */
export function storageConfigurationProblem(): string | null {
  if (process.env.VERCEL && storageDriverName() !== "s3") {
    return "Serverless deployment requires STORAGE_DRIVER=s3 with private object storage";
  }
  return null;
}

export function getStorageDriver(): StorageDriver {
  if (override) return override;
  const problem = storageConfigurationProblem();
  if (problem) throw new AppError(problem, 500, "storage_misconfigured");
  if (storageDriverName() === "local") return localDriver;
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new AppError("Object storage is not configured", 500, "storage_not_configured");
  }
  return new S3StorageDriver({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
    serverSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION?.trim() || null,
  });
}

/** Stores bytes under a random, org-scoped key. Never derived from user input. */
export async function saveUpload(
  orgId: string,
  bytes: Buffer,
  extension: string,
  contentType?: string,
): Promise<string> {
  const key = `${orgId}/${randomUUID()}.${extension}`;
  const target = resolveKey(key);
  if (storageDriverName() === "local" && !override) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  }
  await getStorageDriver().put(key, bytes, contentType);
  return key;
}

export async function readUpload(storageKey: string): Promise<Buffer> {
  resolveKey(storageKey);
  return getStorageDriver().get(storageKey);
}

export async function deleteUpload(storageKey: string): Promise<void> {
  resolveKey(storageKey);
  await getStorageDriver().delete(storageKey);
}

export async function listStoredObjects(prefix = ""): Promise<{ key: string; sizeBytes: number }[]> {
  return getStorageDriver().list ? getStorageDriver().list!(prefix) : [];
}
