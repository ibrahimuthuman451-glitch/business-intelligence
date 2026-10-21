import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../errors";

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new AppError(
      "MFA_ENCRYPTION_KEY must be 32 bytes (base64 or 64-character hex)",
      500,
      "mfa_misconfigured",
    );
  }
  return key;
}

export function mfaEncryptionConfigured(): boolean {
  const raw = process.env.MFA_ENCRYPTION_KEY?.trim();
  if (!raw) return false;
  try {
    decodeKey(raw);
    return true;
  } catch {
    return false;
  }
}

function encryptionKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new AppError(
      "MFA is not available because MFA_ENCRYPTION_KEY is not configured",
      503,
      "mfa_not_configured",
    );
  }
  return decodeKey(raw);
}

/** AES-256-GCM encryption for TOTP secrets at rest. */
export function encryptMfaSecret(secret: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptMfaSecret(payload: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = payload.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) {
    throw new AppError("Stored MFA secret is invalid", 500, "mfa_secret_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Stored MFA secret could not be decrypted", 500, "mfa_secret_invalid");
  }
}

/** Recovery codes are keyed hashes so a database leak alone cannot recover them. */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHmac("sha256", encryptionKey()).update(normalized).digest("hex");
}

export function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let output = "";
  for (const byte of bytes) output += alphabet[byte % alphabet.length];
  return `${output.slice(0, 5)}-${output.slice(5)}`;
}
