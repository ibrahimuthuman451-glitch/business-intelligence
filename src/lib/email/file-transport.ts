import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailTransport, SendResult } from "./transport";

/**
 * Development-only transport. Writes each message as a JSON file so developers
 * can open the verification/reset links without an external service.
 * Never enabled automatically in production.
 */
export class FileEmailTransport implements EmailTransport {
  readonly name = "file";
  private readonly directory: string;

  constructor(directory = process.env.MAIL_OUTBOX_DIR ?? ".data/mail-outbox") {
    this.directory = path.resolve(directory);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${Date.now()}-${id}.json`);
    await writeFile(
      file,
      JSON.stringify(
        {
          id,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? null,
          createdAt: new Date().toISOString(),
          transport: "file",
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    return { messageId: `file:${id}`, accepted: [message.to] };
  }
}
