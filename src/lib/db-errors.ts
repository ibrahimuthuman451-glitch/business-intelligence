const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P03", "3D000"]);

/** Detects database connectivity/migration problems so pages can explain them. */
export function isDatabaseUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: string }).code ?? "")}` : String(error);
  if (/relation .* does not exist/i.test(text)) return true;
  if (/database .* does not exist/i.test(text)) return true;
  for (const code of UNAVAILABLE_CODES) if (text.includes(code)) return true;
  return false;
}

/** Detects PostgreSQL unique-constraint violations, including wrapped driver errors. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = current as { code?: string; message?: string; cause?: unknown };
    if (candidate.code === "23505") return true;
    if (typeof candidate.message === "string" && /duplicate key value violates unique constraint/i.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
