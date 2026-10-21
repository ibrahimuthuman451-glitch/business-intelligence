# Document storage and malware scanning

## Drivers

| `STORAGE_DRIVER` | Use | Notes |
| --- | --- | --- |
| `local` | Development / single-node pilot | Private directory, `0600` files, random org-scoped keys. Requires a persistent volume. |
| `s3` | Staging/production | Private S3-compatible bucket; no public ACLs, no permanent URLs. Requires all `S3_*` variables. |

Downloads always go through `/api/documents/:id/download`, which authorizes the
signed-in actor against the document's own organization, then streams bytes with
`Cache-Control: no-store` and `Content-Disposition: attachment`. Advisor access is
evaluated on every request, so revocation takes effect immediately.

All `S3_*` variables are required when `STORAGE_DRIVER=s3`; the application throws
`storage_not_configured` instead of silently falling back to local disk.

### Suggested bucket policy (AWS/MinIO)

- Block all public access; no bucket ACL grants.
- Application role: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`
  restricted to the bucket/prefix.
- Enable versioning and server-side encryption (the driver requests `AES256`).
- Enable access logging in the provider; do not log object contents.

## Malware scanning

Set `CLAMAV_HOST`/`CLAMAV_PORT` to enable ClamAV `INSTREAM` scanning. The client is
implemented directly over TCP and is covered by a protocol-level test with a fake
clamd server.

- `clean` → stored and marked `scanStatus=clean`.
- `infected` → upload rejected (`malware_detected`); nothing is written or persisted.
- scanner error/timeout → upload rejected (`malware_scan_unavailable`), fail closed.
- no scanner configured → stored as `not_scanned`; `/api/health` reports
  `malwareScanner: not_configured` and the document list shows the state.

**No malware protection is claimed unless `CLAMAV_HOST` is configured and the health
endpoint reports `configured`.** Run ClamAV with an up-to-date signature database and
monitor its availability.

## Validation and safe naming

- Allow-list: PDF, PNG, JPEG, CSV, XLSX, TXT.
- Signature validation (PDF/PNG/JPEG/XLSX magic bytes; NUL check for text).
- 10 MB default limit (`MAX_UPLOAD_BYTES`), enforced before buffering to disk.
- Original filenames are sanitized and never used as object keys.
- Storage keys are `<orgId>/<uuid>.<ext>` and validated against path traversal.
- Quota checks and the document insert run in one transaction with an organization
  row lock, so concurrent uploads cannot exceed plan limits.

## Failure and retention

- If storage write fails, no row is created.
- If the quota/insert fails after a write, the object is deleted.
- If a worker dies mid-upload, an unreferenced object can remain; run `npm run
  storage:audit` to list orphans and missing objects. The audit is read-only.
- Document deletion removes the object and writes an audit event. Deleting an
  organization cascades document rows; run the storage audit afterwards to remove
  residual objects according to your retention policy.
- Recommended retention: financial records 7 years or per local law; delete
  quarantined files immediately; keep audit events longer than documents.

## Backup and recovery

- Local driver: snapshot `UPLOAD_DIR` with the database backup at the same point in
  time, or uploads and metadata will diverge.
- S3: enable bucket versioning and cross-region replication.
- Restore order: database first, then objects. Verify with `npm run storage:audit`
  and a sample authorized download.
- Test restoration quarterly and record the result.

## Supabase Storage / R2 compatibility

Supabase Storage and Cloudflare R2 do **not** implement the SSE
`x-amz-server-side-encryption` header. Leave `S3_SERVER_SIDE_ENCRYPTION` empty for those
providers. AWS S3 encrypts new objects by default, so the header is optional there as well.
Supabase Storage uses path-style access (`S3_FORCE_PATH_STYLE=true`) and the endpoint
`https://<project-ref>.storage.supabase.co/storage/v1/s3`.
