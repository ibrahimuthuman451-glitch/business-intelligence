import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailOutbox, users } from "@/db/schema";
import { createTestContext, type TestContext } from "./helpers";
import {
  EmailError,
  setEmailTransportForTesting,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from "@/lib/email";
import {
  deliverOutboxItem,
  emailOutboxStatus,
  enqueueEmail,
  processEmailOutbox,
  sendEmail,
} from "@/lib/email/outbox";
import { consumeRateLimit } from "@/lib/rate-limit";
import { verificationEmailWithToken } from "@/lib/email/templates";
import { registerUser, verifyEmail } from "@/lib/auth";
import { AppError } from "@/lib/errors";

let context: TestContext;

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  mode: "ok" | "transient" | "permanent" = "ok";
  failuresRemaining = 0;

  async send(message: EmailMessage): Promise<SendResult> {
    if (this.mode !== "ok" || this.failuresRemaining > 0) {
      if (this.failuresRemaining > 0) this.failuresRemaining -= 1;
      throw new EmailError("Synthetic SMTP failure", {
        transient: this.mode !== "permanent",
        code: "synthetic",
      });
    }
    this.messages.push(message);
    return { messageId: `test-${this.messages.length}`, accepted: [message.to] };
  }
}

let transport: RecordingTransport;

beforeAll(async () => {
  context = await createTestContext();
});

afterEach(() => {
  setEmailTransportForTesting(transport);
});

afterAll(async () => {
  setEmailTransportForTesting(null);
  await context.cleanup();
});

describe("email outbox delivery", () => {
  beforeAll(() => {
    transport = new RecordingTransport();
    setEmailTransportForTesting(transport);
  });

  it("sends verification mail and records provider acceptance", async () => {
    const rendered = verificationEmailWithToken("sample-token-value");
    const result = await sendEmail(getDb(), {
      to: "Recipient@Example.com",
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      kind: "auth.verify_email",
    });
    expect(result.status).toBe("sent");
    expect(transport.messages.at(-1)?.to).toBe("recipient@example.com");
    expect(transport.messages.at(-1)?.text).toContain("sample-token-value");

    const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, result.id));
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toContain("test-");
    expect(row?.attempts).toBe(1);
  });

  it("deduplicates messages with the same key", async () => {
    const first = await sendEmail(getDb(), {
      to: "dedupe@example.com",
      subject: "Reminder",
      text: "One reminder",
      kind: "test.dedupe",
      dedupeKey: "dedupe-key-1",
    });
    const second = await sendEmail(getDb(), {
      to: "dedupe@example.com",
      subject: "Reminder",
      text: "One reminder",
      kind: "test.dedupe",
      dedupeKey: "dedupe-key-1",
    });
    expect(first.status).toBe("sent");
    expect(second.status).toBe("duplicate");
    const rows = await getDb().select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, "dedupe-key-1"));
    expect(rows).toHaveLength(1);
    expect(transport.messages.filter((message) => message.subject === "Reminder")).toHaveLength(1);
  });

  it("keeps transient failures queued with backoff and retries successfully", async () => {
    const queued = await enqueueEmail(getDb(), {
      to: "retry@example.com",
      subject: "Retry me",
      text: "Eventually delivered",
      kind: "test.retry",
    });
    transport.mode = "transient";
    const failed = await deliverOutboxItem(getDb(), queued.id, transport);
    expect(failed.status).toBe("queued");

    let [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    transport.mode = "ok";
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const summary = await processEmailOutbox(getDb(), { transport, now: later, limit: 50 });
    expect(summary.sent).toBeGreaterThanOrEqual(1);
    [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
    expect(row?.status).toBe("sent");
  });

  it("marks permanent failures as failed and never claims delivery", async () => {
    const queued = await enqueueEmail(getDb(), {
      to: "bounce@example.com",
      subject: "Will fail",
      text: "No delivery",
      kind: "test.failure",
    });
    transport.mode = "permanent";
    const result = await deliverOutboxItem(getDb(), queued.id, transport);
    expect(result.status).toBe("failed");
    const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
    expect(row?.status).toBe("failed");
    expect(row?.sentAt).toBeNull();
    expect(row?.lastError).toContain("Synthetic SMTP failure");
  });

  it("stops after the configured maximum attempts", async () => {
    const queued = await enqueueEmail(getDb(), {
      to: "retry-limit@example.com",
      subject: "Limited",
      text: "Never delivered",
      kind: "test.retry_limit",
    });
    transport.mode = "transient";
    let attempts = 0;
    while (attempts < 6) {
      await deliverOutboxItem(getDb(), queued.id, transport);
      attempts += 1;
      const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
      if (row?.status === "failed") break;
      await getDb()
        .update(emailOutbox)
        .set({ nextAttemptAt: new Date(Date.now() - 1000), status: "queued" })
        .where(eq(emailOutbox.id, queued.id));
    }
    const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(5);
  });

  it("fails safely when no transport is configured", async () => {
    setEmailTransportForTesting(null);
    process.env.EMAIL_TRANSPORT = "disabled";
    const result = await sendEmail(getDb(), {
      to: "noconfig@example.com",
      subject: "No transport",
      text: "Should fail safely",
      kind: "test.disabled",
    });
    delete process.env.EMAIL_TRANSPORT;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not configured/i);
    setEmailTransportForTesting(transport);
  });

  it("reports outbox health counts", async () => {
    const status = await emailOutboxStatus(getDb());
    expect(status.sent).toBeGreaterThan(0);
    expect(status.failed).toBeGreaterThan(0);
  });
});

describe("rate limiting and token hardening", () => {
  it("atomically enforces a fixed-window limit under concurrency", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeRateLimit(getDb(), { bucket: "test_concurrent", key: "client", limit: 5, windowSeconds: 3600 }),
      ),
    );
    expect(attempts.filter((result) => result.allowed)).toHaveLength(5);
    expect(attempts.filter((result) => !result.allowed)).toHaveLength(5);
  });

  it("expires unused verification tokens", async () => {
    const email = "expired-token@example.com";
    const registration = await registerUser(context.db, {
      name: "Expired Token",
      email,
      password: "CorrectHorse9!",
      organizationName: "Expired Token Co",
    });
    const { verificationTokens } = await import("@/db/schema");
    await context.db
      .update(verificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verificationTokens.userId, registration.userId));
    await expect(verifyEmail(context.db, registration.emailVerificationToken)).rejects.toBeInstanceOf(AppError);
  });

  it("does not leak tokens into user records or password hashes", async () => {
    const email = "token-check@example.com";
    const registration = await registerUser(context.db, {
      name: "Token Check",
      email,
      password: "CorrectHorse9!",
      organizationName: "Token Check Co",
    });
    const [user] = await context.db.select().from(users).where(eq(users.id, registration.userId));
    expect(JSON.stringify(user)).not.toContain(registration.emailVerificationToken);
    const queued = await getDb()
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.toEmail, email))
      .orderBy(desc(emailOutbox.createdAt))
      .limit(1);
    expect(queued[0]?.bodyText ?? "").not.toContain("CorrectHorse9!");
  });
});
