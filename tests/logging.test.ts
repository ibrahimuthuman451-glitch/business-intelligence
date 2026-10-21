import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "@/lib/logger";

describe("error log redaction", () => {
  it("drops SQL parameters containing financial and personal data", () => {
    const error = new Error(
      "Failed query: insert into \"sales\" (\"description\", \"amount_cents\") values ($1, $2)\nparams: Client Alpha,125000,owner@example.com",
    );
    (error as { code?: string }).code = "23505";
    const message = safeErrorMessage(error);
    expect(message).toContain("database query failed");
    expect(message).toContain("23505");
    expect(message).not.toContain("125000");
    expect(message).not.toContain("owner@example.com");
    expect(message).not.toContain("Client Alpha");
  });

  it("redacts emails and secrets from ordinary messages", () => {
    const message = safeErrorMessage(new Error("SMTP rejected user@example.com with token=abc123"));
    expect(message).not.toContain("user@example.com");
    expect(message).not.toContain("abc123");
    expect(message).toContain("[email]");
  });
});
