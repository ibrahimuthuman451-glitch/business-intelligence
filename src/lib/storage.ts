import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 1024 * 1024;
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

/** Stores bytes under a random, org-scoped key. Never derived from user input. */
export async function saveUpload(orgId: string, bytes: Buffer, extension: string): Promise<string> {
  const key = `${orgId}/${randomUUID()}.${extension}`;
  const target = path.join(uploadRoot(), key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  return key;
}

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

export async function readUpload(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(resolveKey(storageKey));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("The stored file is unavailable", 404, "document_missing");
  }
}

export async function deleteUpload(storageKey: string): Promise<void> {
  await rm(resolveKey(storageKey), { force: true });
}
