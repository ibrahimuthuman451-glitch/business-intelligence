# Production-like staging validation (21 Oct 2026)

This records what was actually executed in this environment. It is deliberately split
into verified locally, verified against real protocol implementations, and **not**
verified against an external provider.

## Environment

- PostgreSQL **16.4** (real server, not PGlite), fresh `bi_staging` database.
- Application built with `npm run build`, started with `NODE_ENV=production` and
  `DATABASE_URL`, S3 storage, SMTP, real ClamAV, MFA key and `JOBS_SECRET`.
- SMTP: real SMTP protocol server (`smtp-server`) with username/password authentication
  on loopback.
- Storage: S3-compatible server (`s3rver` 3.7.1) on loopback, bucket
  `ledgerline-staging`.
- Malware: **real ClamAV daemon 1.4.3** installed from Debian packages, running
  `clamd` on 127.0.0.1:3310 with an EICAR test signature database.

## Results

| Check | Result |
| --- | --- |
| PostgreSQL migrations (0000–0002) from empty DB | passed |
| Full suite on PostgreSQL | **133/133 passed (18 files)** |
| Full suite on PGlite | **127 passed, 6 PostgreSQL-only skipped** |
| SMTP authentication + delivery over real SMTP | **4/4 tests passed**; `verify:smtp` accepted |
| SMTP wrong password classified permanent | passed |
| SMTP unreachable classified transient | passed |
| Email outbox → SMTP provider acceptance | passed |
| S3 driver put/get/list/delete | passed |
| App upload → S3 → authorized download → delete | passed |
| Anonymous S3 GET on local emulator | **returned 200 — emulator allows anonymous reads; real bucket policy not verified** |
| ClamAV clean scan | `clean` / `stream: OK` |
| ClamAV EICAR detection | `infected` / `Eicar-Test-Signature FOUND` |
| App upload scanned clean | `scanStatus=clean` |
| App infected upload | rejected with `malware_detected`; no row/object |
| Secure session cookie | `Secure; HttpOnly; SameSite=lax` observed on login |
| CSP / HSTS / X-Frame / nosniff | present on responses |
| MFA password → challenge → TOTP → session | passed; dashboard 200 |
| Owner/advisor demo login and pages | dashboard, documents, tenders, tasks, notifications, reports, settings, team all 200 |
| Advisor document download | 200 |
| Cross-tenant document download (outsider) | **403** |
| Report download | 200 `text/csv`, `no-store` |
| Jobs with `JOBS_SECRET` | no auth 401; wrong 401; correct 200 and `job_runs` completed |
| Job email delivery | 3 messages `sent` through SMTP |
| Backup `pg_dump` 16.15 → new DB `pg_restore` → migrate | passed; 2 users, 2 orgs, 2 docs, 1 invoice, 39 audit events |
| Production without `DATABASE_URL` | `/api/health` **503**, no PGlite fallback |
| Production `EMAIL_TRANSPORT=file` | health reports `disabled`, `configured:false` |

Commands used are the documented `npm run verify:smtp|s3|clamav`, `npm run jobs:run`,
`npm run db:migrate`, `pg_dump`/`pg_restore` and the normal `next start` process.

## Not verified (must be done against real providers)

1. A real transactional email provider (deliverability, SPF/DKIM/DMARC, bounce handling).
2. A real private cloud bucket and its bucket policy (the local S3 emulator allows
   anonymous GET, so the `verify:s3` public-access check correctly failed there).
3. ClamAV with full production signature databases and operational monitoring. The real
   daemon/EICAR scan proves the protocol and application integration, not signature freshness.
4. OS-level cron/systemd scheduling; the job command and persisted `job_runs` were
   validated, but no scheduler was installed in this sandbox.
5. Browser-driven E2E (no browser installed); the demo journey is covered at
   service/HTTP-handler level plus the manual HTTP session checks above.
6. GitHub Actions execution; the workflow could not be pushed due to missing workflow
   permission. See `docs/CI.md`.

## Known operational caveats

- The S3 emulator is not a security substitute. A real bucket must have public access
  blocked and `npm run verify:s3` must pass the anonymous GET check.
- ClamAV must run with `freshclam`/managed signatures and health monitoring.
- SMTP verification confirms provider acceptance only; mailbox delivery still needs a
  human check in the target inbox.
- Staging used a synthetic demo workspace; no customer data was present.
