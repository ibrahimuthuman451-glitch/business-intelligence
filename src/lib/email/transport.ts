export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type SendResult = { messageId: string; accepted: string[] };

export class EmailError extends Error {
  readonly transient: boolean;
  readonly code: string;

  constructor(message: string, options: { transient: boolean; code?: string }) {
    super(message);
    this.name = "EmailError";
    this.transient = options.transient;
    this.code = options.code ?? "email_error";
  }
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailNotConfiguredError extends EmailError {
  constructor() {
    super("Email is not configured on this server", { transient: false, code: "email_not_configured" });
    this.name = "EmailNotConfiguredError";
  }
}
