import { createTransport, type Transporter } from "nodemailer";
import { EmailError, type EmailMessage, type EmailTransport, type SendResult } from "./transport";

function classify(error: unknown): EmailError {
  const candidate = error as { code?: string; responseCode?: number; message?: string };
  const code = candidate.code ?? "smtp_error";
  const responseCode = candidate.responseCode ?? 0;
  const transientCodes = new Set([
    "ECONNECTION",
    "ETIMEDOUT",
    "ESOCKET",
    "EDNS",
    "ECONNRESET",
    "EENVELOPE",
  ]);
  const transient =
    transientCodes.has(code) || (responseCode >= 400 && responseCode < 500) || responseCode === 0;
  return new EmailError(
    `SMTP delivery failed (${code}${responseCode ? ` ${responseCode}` : ""})`,
    { transient, code },
  );
}

export class SmtpEmailTransport implements EmailTransport {
  readonly name = "smtp";
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: { url: string; from: string }) {
    this.transporter = createTransport(options.url);
    this.from = options.from;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      const acceptedList = (info.accepted ?? []) as (string | { address: string })[];
      const accepted = acceptedList.map((value) =>
        typeof value === "string" ? value : value.address,
      );
      if (accepted.length === 0) {
        throw new EmailError("SMTP server did not accept the recipient", {
          transient: false,
          code: "recipient_rejected",
        });
      }
      return { messageId: info.messageId ?? "unknown", accepted };
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw classify(error);
    }
  }
}
