import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export type TotpVerification = { valid: boolean; counter: number | null };

/**
 * Verifies a 6-digit TOTP code with a +/- one step window. The returned counter
 * is persisted by the caller to reject replay of the same time step.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: Date; window?: number; stepSeconds?: number } = {},
): TotpVerification {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return { valid: false, counter: null };
  const now = options.now ?? new Date();
  const step = options.stepSeconds ?? 30;
  const window = options.window ?? 1;
  const counter = Math.floor(now.getTime() / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = counter + offset;
    if (candidate < 0) continue;
    const expected = Buffer.from(hotp(secret, candidate));
    const actual = Buffer.from(normalized);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { valid: true, counter: candidate };
    }
  }
  return { valid: false, counter: null };
}

export function totpUri(input: { email: string; secret: string; issuer?: string }): string {
  const issuer = input.issuer ?? "Ledgerline";
  const label = encodeURIComponent(`${issuer}:${input.email}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
