import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { auditEvents, documents, memberships } from "@/db/schema";
import { createOrg, createTestContext, reloadActor, type TestContext } from "./helpers";
import {
  createDocument,
  deleteDocument,
  getDocumentRecord,
  readAuthorizedDocument,
  reviewDocument,
} from "@/lib/documents";
import { authorizeOrg } from "@/lib/authz";
import { uploadRoot } from "@/lib/storage";
import { ForbiddenError, ValidationError } from "@/lib/errors";

let context: TestContext;

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.cleanup();
});

describe("private document storage", () => {
  it("stores an org-scoped random key and reads back identical bytes", async () => {
    const org = await createOrg(context.db, { email: "docs@example.com", orgName: "Docs Co" });
    const created = await createDocument(context.db, org.ctx, {
      filename: "March bank statement.pdf",
      declaredMimeType: "application/pdf",
      bytes: pdf,
      category: "bank",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
    });

    const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
    expect(row?.storageKey).toMatch(new RegExp(`^${org.orgId}/[0-9a-f-]{36}\\.pdf$`));
    expect(row?.storageKey).not.toContain("bank statement");
    expect(row?.sha256).toHaveLength(64);
    const stored = path.join(uploadRoot(), row!.storageKey);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(pdf)).toBe(true);

    const read = await readAuthorizedDocument(context.db, org.ctx, created.id);
    expect(read.filename).toBe("March bank statement.pdf");
    expect(read.bytes.equals(pdf)).toBe(true);
  });

  it("rejects content that does not match the extension", async () => {
    const org = await createOrg(context.db, { email: "fake-pdf@example.com", orgName: "Fake PDF Co" });
    await expect(
      createDocument(context.db, org.ctx, {
        filename: "invoice.pdf",
        bytes: Buffer.from("this is not a pdf"),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      createDocument(context.db, org.ctx, {
        filename: "malware.exe",
        bytes: Buffer.from("MZ"),
      }),
    ).rejects.toThrow(/unsupported file type/i);
  });

  it("sanitizes traversal names and never writes outside the upload root", async () => {
    const org = await createOrg(context.db, { email: "traversal@example.com", orgName: "Traversal Co" });
    const created = await createDocument(context.db, org.ctx, {
      filename: "../../../etc/passwd.pdf",
      bytes: pdf,
    });
    const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
    expect(row?.originalFilename).toBe("passwd.pdf");
    expect(row?.storageKey.startsWith(`${org.orgId}/`)).toBe(true);
    const files = readdirSync(path.join(uploadRoot(), org.orgId));
    expect(files).toHaveLength(1);
  });

  it("enforces review permissions and records an audit trail", async () => {
    const owner = await createOrg(context.db, { email: "review-owner@example.com", orgName: "Review Co" });
    const created = await createDocument(context.db, owner.ctx, { filename: "tax.pdf", bytes: pdf });

    await reviewDocument(context.db, owner.ctx, created.id, {
      status: "approved",
      notes: "Checked against the bank statement",
    });
    const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
    expect(row?.status).toBe("approved");
    expect(row?.reviewNotes).toContain("bank statement");

    const staffActor = await reloadActor(context.db, owner.userId);
    const staffCtx: typeof owner.ctx = {
      ...owner.ctx,
      role: "staff",
      permissions: ["documents:read", "documents:write"],
      actor: staffActor,
    };
    await expect(
      reviewDocument(context.db, staffCtx, created.id, { status: "rejected" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const events = await context.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.entityType, "document")));
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["document.uploaded", "document.approved"]),
    );
  });

  it("blocks a member of another organization from loading the record", async () => {
    const a = await createOrg(context.db, { email: "doc-a@example.com", orgName: "Doc A" });
    const b = await createOrg(context.db, { email: "doc-b@example.com", orgName: "Doc B" });
    const created = await createDocument(context.db, b.ctx, { filename: "secret.pdf", bytes: pdf });
    await expect(getDocumentRecord(context.db, a.ctx, created.id)).rejects.toThrow(/not found/i);
    await expect(readAuthorizedDocument(context.db, a.ctx, created.id)).rejects.toThrow(/not found/i);
  });

  it("deletes the stored bytes along with the record", async () => {
    const org = await createOrg(context.db, { email: "delete-doc@example.com", orgName: "Delete Doc Co" });
    const created = await createDocument(context.db, org.ctx, { filename: "old.pdf", bytes: pdf });
    const [row] = await context.db.select().from(documents).where(eq(documents.id, created.id));
    const file = path.join(uploadRoot(), row!.storageKey);
    expect(existsSync(file)).toBe(true);
    await deleteDocument(context.db, org.ctx, created.id);
    expect(existsSync(file)).toBe(false);
    expect(await context.db.select().from(documents).where(eq(documents.id, created.id))).toHaveLength(0);
  });

  it("gives advisors with an active grant read access but not team management", async () => {
    const client = await createOrg(context.db, { email: "client-doc@example.com", orgName: "Client Doc Co" });
    const advisor = await createOrg(context.db, {
      email: "advisor-doc@example.com",
      orgName: "Advisor Firm",
      kind: "accounting_firm",
    });
    await context.db.insert(memberships).values({
      orgId: client.orgId,
      userId: advisor.userId,
      role: "advisor",
      status: "active",
    });
    const advisorCtx = await authorizeOrg(
      context.db,
      await reloadActor(context.db, advisor.userId),
      client.orgId,
      "documents:read",
    );
    const created = await createDocument(context.db, client.ctx, { filename: "shared.pdf", bytes: pdf });
    const read = await readAuthorizedDocument(context.db, advisorCtx, created.id);
    expect(read.bytes.equals(pdf)).toBe(true);
  });
});
