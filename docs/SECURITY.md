# Security notes

## Tenant isolation

Authorization is enforced in the service layer, not in the UI. The pattern is:

1. Resolve the session token → user (`resolveSession`).
2. Load active memberships and advisor grants (`loadActor`).
3. `authorizeOrg(db, actor, orgId, permission)` checks the role matrix and, for
   advisors, an `advisor_access` row with `status='active'` granted by the client.
4. Every query filters by the authorized `orgId`. Entity lookups use
   `and(eq(table.id, id), eq(table.orgId, ctx.orgId))`, so an id from another
   tenant returns 404 rather than leaking existence.

Document downloads (`/api/documents/:id/download`) do **not** use the active-org
cookie for authorization. They load the document, then authorize the actor against
the document's own organization. The file is streamed from a private directory;
there is no static route that maps a URL to a storage key.

Automated coverage: `tests/tenant-isolation.test.ts` exercises the service layer
and calls the real route handlers with forged/organization-mismatched cookies,
asserting that no bytes are returned. `tests/team.test.ts` proves pending grants
and revoked grants cannot read client data and that revocation leaves no
membership behind.

## Session handling

- 256-bit random tokens stored as SHA-256 hashes.
- 30-day sliding-free expiry (`SESSION_TTL_DAYS`), revoked on logout and password
  change/reset.
- Login failures are written to `audit_events`; eight failures for an email in ten
  minutes produce HTTP 429.
- Email verification and reset tokens are single-use, hashed at rest and expire.

## File uploads

- Allowed: PDF, PNG, JPEG, CSV, XLSX, TXT. Extension allow-list plus signature
  checks (PDF/PNG/JPEG/XLSX magic bytes, NUL check for text).
- Maximum size is enforced before buffering (`MAX_UPLOAD_BYTES`, default 10 MB).
- Storage keys are random UUIDs scoped by organization; the original filename is
  never part of the path. Path resolution is checked against the upload root.
- Files are created mode `0600`, directories `0700`.

## Known limitations / remaining risks

1. **No antivirus/CDR scanning.** Magic-byte validation stops extension spoofing
   but not a malicious yet structurally valid PDF. Add ClamAV or a cloud malware
   scanner before accepting untrusted public uploads at scale.
2. **No SMTP provider.** Verification and reset links are logged on the server.
   Implement `deliverEmail()` and set `AUTH_DEV_EXPOSE_TOKENS=false` (default).
3. **No MFA.** Add TOTP/WebAuthn for owners and firm administrators.
4. **Local file storage is single-node.** For multi-instance deployments replace
   `src/lib/storage.ts` with S3-compatible object storage and short-lived signed
   URLs issued only after the same authorization check. Never make the bucket
   public.
5. **PGlite is a development/test database.** It is single-writer. Production must
   use PostgreSQL via `DATABASE_URL`.
6. **Audit immutability.** Events are append-only through the application but the
   database role is not restricted from updates. Grant the app role INSERT/SELECT
   only on `audit_events` and ship events to append-only storage for compliance.
7. **Rate limiting is login-only.** Add edge rate limiting for registration,
   password reset and uploads.
8. **Moderate dev-only advisory.** `npm audit` reports moderate issues in
   `drizzle-kit`'s dev toolchain (`@esbuild-kit/*` → `esbuild`). They affect the
   local migration generator only and are not part of the runtime bundle. The
   suggested fix is a semver-major downgrade of drizzle-kit, so it was not forced.
9. **No automated XLSX generation test.** XLSX parsing is implemented with
   `read-excel-file`; the CSV path is covered by tests. Validate with real exports
   before production use.
10. **Platform admin bootstrap.** The first platform admin must be flagged in the
    database (`update users set is_platform_admin = true ...`) inside a controlled
    procedure; there is no UI for granting the flag. This is intentional.
