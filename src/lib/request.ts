import { headers } from "next/headers";
import { AppError } from "./errors";
import { logServerError } from "./logger";

export type RequestMeta = { ipAddress: string | null; userAgent: string | null };

export async function requestMeta(): Promise<RequestMeta> {
  const store = await headers();
  return {
    ipAddress: store.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: store.get("user-agent"),
  };
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Only same-origin, absolute-path redirects are permitted. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/app/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/app/dashboard";
  return value;
}

export function tokenLinksExposed(): boolean {
  return process.env.AUTH_DEV_EXPOSE_TOKENS === "true" && process.env.NODE_ENV !== "production";
}

/** Minimal mail transport: logs a link. Replace with a provider in production. */
export async function deliverEmail(input: { to: string; subject: string; link: string }): Promise<void> {
  console.info(
    `[email] to=${input.to} subject="${input.subject}" link=${input.link} (no SMTP provider configured)`,
  );
}

export function describeError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  logServerError("request_error", error);
  return "Something went wrong. Please try again.";
}
