import { FileEmailTransport } from "./file-transport";
import { SmtpEmailTransport } from "./smtp-transport";
import {
  EmailError,
  EmailNotConfiguredError,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from "./transport";

export * from "./transport";
export { FileEmailTransport, SmtpEmailTransport };

class DisabledEmailTransport implements EmailTransport {
  readonly name = "disabled";
  async send(_message: EmailMessage): Promise<SendResult> {
    throw new EmailNotConfiguredError();
  }
}

let override: EmailTransport | null = null;

/** Test seam; never used by application code. */
export function setEmailTransportForTesting(transport: EmailTransport | null): void {
  override = transport;
}

export function emailTransportMode(): "smtp" | "file" | "disabled" {
  const explicit = process.env.EMAIL_TRANSPORT?.trim();
  if (explicit === "file" && process.env.NODE_ENV === "production") return "disabled";
  if (explicit === "smtp" || explicit === "file" || explicit === "disabled") return explicit;
  if (process.env.SMTP_URL?.trim()) return "smtp";
  return process.env.NODE_ENV === "production" ? "disabled" : "file";
}

export function getEmailTransport(): EmailTransport {
  if (override) return override;
  const mode = emailTransportMode();
  if (mode === "smtp") {
    const url = process.env.SMTP_URL?.trim();
    const from = process.env.EMAIL_FROM?.trim();
    if (!url || !from) throw new EmailNotConfiguredError();
    return new SmtpEmailTransport({ url, from });
  }
  if (mode === "file") return new FileEmailTransport();
  return new DisabledEmailTransport();
}

/** True when links may be shown in the UI instead of relying on email. */
export function linksVisibleInUi(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (
    process.env.AUTH_DEV_EXPOSE_TOKENS === "true" || emailTransportMode() === "file"
  );
}

export function isEmailConfigured(): boolean {
  const mode = emailTransportMode();
  if (mode === "smtp") return Boolean(process.env.SMTP_URL?.trim() && process.env.EMAIL_FROM?.trim());
  return mode === "file";
}

export { EmailError };
