import argon2 from "argon2";
import { ValidationError } from "./errors";

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "123456789012",
  "qwertyuiop12",
  "letmein12345",
  "administrator",
  "welcome12345",
]);

export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 200;

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function validatePasswordStrength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError("Password is too long");
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new ValidationError("That password is too common. Choose something less predictable.");
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError("Password must contain at least one letter and one number");
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordStrength(password);
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Constant-work dummy verification used when the account does not exist. */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3X0k5S3mJzZ4g0z3G6yF7c8y3SJ8g1vJ0y6m9Ck2X4Y";

export async function fakeVerify(password: string): Promise<void> {
  try {
    await argon2.verify(DUMMY_HASH, password);
  } catch {
    // Intentionally ignored: this only equalizes timing for unknown accounts.
  }
}
