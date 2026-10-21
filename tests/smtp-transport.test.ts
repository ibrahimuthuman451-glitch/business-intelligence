import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { SmtpEmailTransport } from "@/lib/email";
import { EmailError } from "@/lib/email/transport";
import { sendEmail } from "@/lib/email/outbox";
import { createTestContext, type TestContext } from "./helpers";

let context: TestContext;
let server: SMTPServer;
let port: number;
const received: { subject: string; to: string; body: string }[] = [];
const USER = "staging-user";
const PASS = "staging-password";

beforeAll(async () => {
  context = await createTestContext();
  server = new SMTPServer({
    secure: false,
    authOptional: false,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _session, callback) {
      if (auth.username === USER && auth.password === PASS) callback(null, { user: USER });
      else callback(new Error("Invalid login"));
    },
    onData(stream, session, callback) {
      let body = "";
      stream.on("data", (chunk) => {
        body += chunk.toString();
      });
      stream.on("end", () => {
        const subject = /^Subject: (.*)$/m.exec(body)?.[1]?.trim() ?? "";
        const to = session.envelope.rcptTo.map((entry) => entry.address).join(",");
        received.push({ subject, to, body });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server did not start");
  port = address.port;
});

afterEach(() => {
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.SMTP_URL;
  delete process.env.EMAIL_FROM;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await context.cleanup();
});

describe("real SMTP protocol transport", () => {
  it("authenticates and delivers through a real SMTP server", async () => {
    const transport = new SmtpEmailTransport({
      url: `smtp://${USER}:${PASS}@127.0.0.1:${port}`,
      from: "Ledgerline Staging <no-reply@staging.example>",
    });
    const result = await transport.send({
      to: "owner@example.com",
      subject: "SMTP staging verification",
      text: "This message was delivered over SMTP.",
    });
    expect(result.accepted).toContain("owner@example.com");
    const message = received.find((entry) => entry.subject === "SMTP staging verification");
    expect(message?.to).toBe("owner@example.com");
    expect(message?.body).toContain("delivered over SMTP");
  });

  it("reports authentication rejection as a permanent failure", async () => {
    const transport = new SmtpEmailTransport({
      url: `smtp://${USER}:wrong-password@127.0.0.1:${port}`,
      from: "Ledgerline Staging <no-reply@staging.example>",
    });
    await expect(
      transport.send({ to: "owner@example.com", subject: "Should fail", text: "No" }),
    ).rejects.toMatchObject({ name: "EmailError", transient: false });
  });

  it("marks an unreachable SMTP server as transient", async () => {
    const transport = new SmtpEmailTransport({
      url: "smtp://127.0.0.1:1",
      from: "Ledgerline Staging <no-reply@staging.example>",
    });
    await expect(
      transport.send({ to: "owner@example.com", subject: "Unreachable", text: "No" }),
    ).rejects.toSatisfy((error: unknown) => error instanceof EmailError && error.transient);
  });

  it("records provider acceptance in the email outbox through the real SMTP path", async () => {
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_URL = `smtp://${USER}:${PASS}@127.0.0.1:${port}`;
    process.env.EMAIL_FROM = "Ledgerline Staging <no-reply@staging.example>";
    const result = await sendEmail(context.db, {
      to: "invitee@example.com",
      subject: "Outbox SMTP verification",
      text: "Outbox to SMTP",
      kind: "staging.smtp",
    });
    expect(result.status).toBe("sent");
    expect(received.some((entry) => entry.subject === "Outbox SMTP verification")).toBe(true);
  });
});
