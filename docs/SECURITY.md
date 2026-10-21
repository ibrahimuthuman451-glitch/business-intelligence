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
- Optional ClamAV `INSTREAM` scanning: infected uploads are rejected before storage;
  scanner outages fail closed; unscanned state is visible in the UI and health endpoint.
- Plan quotas (document count and bytes) are checked under an organization row lock in the
  same transaction as the insert, preventing concurrent bypass.

## Known limitations / remaining risks

1. **No antivirus/CDR scanning.** Magic-byte validation stops extension spoofing
   but not a malicious yet structurally valid PDF. Add ClamAV or a cloud malware
   scanner before accepting untrusted public uploads at scale.
2. **Email depends on operator SMTP.** The outbox, retries and rate limits are
   implemented and tested; actual inbox delivery must be verified in staging with the
   configured provider. `AUTH_DEV_EXPOSE_TOKENS` must remain false.
3. **No MFA.** Still outstanding; add TOTP/WebAuthn for owners and firm administrators
   before handling high-value customer data. This is a pilot blocker for some customers.
4. **Object storage is implemented but not verified against a live bucket.** The S3
   driver is covered by configuration tests; staging must verify upload/download/delete
   against the chosen provider. No public URLs are generated.
5. **PGlite is a development/test database.** It is single-writer. Production must
   use PostgreSQL via `DATABASE_URL`.
6. **Audit immutability.** Events are append-only through the application but the
   database role is not restricted from updates. Grant the app role INSERT/SELECT
   only on `audit_events` and ship events to append-only storage for compliance.
7. **Rate limiting covers login and sensitive email actions.** Edge/global rate limiting
   and upload throttling still need a reverse proxy or gateway.
8. **Moderate dev-only advisory.** `npm audit` reports moderate issues in
   `drizzle-kit`'s dev toolchain (`@esbuild-kit/*` → `esbuild`). They affect the
   local migration generator only and are not part of the runtime bundle. The
   suggested fix is a semver-major downgrade of drizzle-kit, so it was not forced.
9. **XLSX is tested with synthetic OOXML fixtures**, not official EBM exports. Validate
   with authorized real exports before claiming EBM compatibility.
10. **Platform admin bootstrap.** The first platform admin must be flagged in the
    database (`update users set is_platform_admin = true ...`) inside a controlled
    procedure; there is no UI for granting the flag. This is intentional.
