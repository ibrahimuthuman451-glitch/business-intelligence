/** Sends one message through the configured SMTP provider. Never prints credentials. */
import { getEmailTransport, emailTransportMode } from "../src/lib/email";

async function main() {
  const to = process.env.VERIFY_EMAIL_TO?.trim();
  if (!to) throw new Error("Set VERIFY_EMAIL_TO to a mailbox you control");
  if (emailTransportMode() !== "smtp") throw new Error("EMAIL_TRANSPORT must be smtp");
  const transport = getEmailTransport();
  const result = await transport.send({
    to,
    subject: "Ledgerline staging email verification",
    text: `This is a staging verification message from Ledgerline at ${new Date().toISOString()}. No customer data is included.`,
  });
  console.log(JSON.stringify({ status: "accepted", providerMessageId: result.messageId, acceptedRecipients: result.accepted.length }));
}

main().catch((error) => {
  console.error("SMTP verification failed:", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
