/**
 * Error logging with redaction. Database driver errors embed SQL parameters
 * (amounts, emails, tokens), so those are deliberately dropped rather than
 * written to logs.
 */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const code = (error as { code?: string }).code;
  const name = error.name || "Error";
  const message = error.message ?? "";

  if (/^Failed query:/i.test(message)) {
    return `${name}: database query failed${code ? ` (${code})` : ""}`;
  }

  let cleaned = message.split("\nparams:")[0] ?? message;
  cleaned = cleaned.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  cleaned = cleaned.replace(/(password|token|secret)=[^\s&,]+/gi, "$1=[redacted]");
  return `${name}: ${cleaned.slice(0, 300)}`;
}

export function logServerError(context: string, error: unknown, extra?: Record<string, string | number | boolean | null>) {
  const code = (error as { code?: string })?.code;
  console.error(
    JSON.stringify({
      level: "error",
      context,
      error: safeErrorMessage(error),
      code: code ?? null,
      ...extra,
      at: new Date().toISOString(),
    }),
  );
}
