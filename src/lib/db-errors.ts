const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P03", "3D000"]);

/** Detects database connectivity/migration problems so pages can explain them. */
export function isDatabaseUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: string }).code ?? "")}` : String(error);
  if (/relation .* does not exist/i.test(text)) return true;
  if (/database .* does not exist/i.test(text)) return true;
  for (const code of UNAVAILABLE_CODES) if (text.includes(code)) return true;
  return false;
}
