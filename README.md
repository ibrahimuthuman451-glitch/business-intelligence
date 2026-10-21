# Ledgerline — business intelligence workspace

A production-oriented SaaS for Rwandan businesses and their accountants: real books,
private document rooms, verified tender intake, CSV/XLSX reconciliation, tasks,
notifications and audit trails — with server-enforced tenant isolation.

Stack: **Next.js 16 (App Router) · React 19 · TypeScript · Drizzle ORM · PostgreSQL 16
(embedded PGlite for local development) · Vitest**.

---

## Current status

| Area | State |
| --- | --- |
| Database | 32 tables, constraints/indexes/FKs, migrations `0000` + `0001` |
| Authentication | Registration, login/logout, verification, reset, session revocation, login throttling |
| Tenancy | Server-side authorization on every service and file download; cross-tenant tests |
| Advisor access | Client grant → invite acceptance → revocation; audited and tested |
| Documents | Local/S3 abstraction, magic-byte validation, quotas, ClamAV interface, review, requests |
| Finance | Sales, expenses, contacts, invoices, payments, dashboard, ageing |
| Tenders | Verified manual import with provenance, saved opportunities, deadlines, relevance, checklists |
| Reconciliation | CSV/XLSX, configurable mapping, synthetic fixtures, traceable findings, human review |
| Tasks & notifications | CRUD, assignment, periods, overdue views, inbox, preferences, deduplicated reminders |
| Email | SMTP/file/disabled transports, DB outbox, retries, rate limits, delivery status |
| Entitlements | Central plans + DB overrides; transactional quotas; advanced export gating |
| Reports | CSV exports with spreadsheet-formula injection protection |
| Background jobs | Persisted runner via CLI and guarded endpoint; no in-memory timers |
| Live EBM/RRA | **Not implemented or claimed**; file import only, no government credentials |
| Live tender feed | **Not implemented or claimed**; verified manual import only |
| MFA | Not implemented — documented pilot risk |
| Payment gateway | Not implemented; no provider terms/fees verified |

---

## Quick start (local)

Requirements: Node.js 22+, npm. PostgreSQL is optional locally.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed          # labelled demo workspace
npm run dev              # http://localhost:3000
```

Demo logins (all records fictional):

```
owner:   demo@ledgerline.local / DemoPassword9!
advisor: advisor@demo-firm.local / DemoPassword9!
```

`npm run demo:reset` restores only the demo organizations. Real customer data is never
touched; this is covered by a PostgreSQL test.

### Commands

```bash
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm test                 # PGlite suites
npm run test:postgres    # PostgreSQL suites (requires TEST_DATABASE_URL)
npm run build            # production build
npm run db:generate      # new migration from schema
npm run db:migrate       # apply migrations (Postgres or PGlite)
npm run db:seed          # demo data
npm run demo:reset       # restore demo only
npm run jobs:run         # reminders + email retries (schedule every 15 min)
npm run storage:audit    # read-only storage consistency report
```

---

## Production / staging

1. Provision PostgreSQL 14+ (verified on 16.4) and set `DATABASE_URL`.
2. Set `APP_URL` to the HTTPS origin, `NODE_ENV=production` (Secure cookies).
3. Choose private storage: `STORAGE_DRIVER=s3` with bucket credentials, or `local` with
   a private persistent volume. Never expose `UPLOAD_DIR` over HTTP.
4. Configure SMTP (`EMAIL_TRANSPORT=smtp`, `SMTP_URL`, `EMAIL_FROM`) and verify delivery.
5. Optionally configure `CLAMAV_HOST`; uploads fail closed when it is configured but down.
6. Set `JOBS_SECRET`, run `npm run db:migrate`, back up first, then `npm run build && npm start`.
7. Schedule `npm run jobs:run` every 15 minutes (cron/systemd) or call the guarded endpoint.
8. Keep `AUTH_DEV_EXPOSE_TOKENS=false`. Create the first platform admin via the SQL runbook.

Full deployment, backup, rollback and platform-admin instructions: `docs/OPERATIONS.md`.
Health: `GET /api/health` (never returns secrets).

---

## Architecture

```
src/
  app/                 App Router pages, server actions, API routes
    app/               dashboard, finance, documents, tenders, reconciliation, tasks, reports…
    api/               health, private downloads, reconciliation preview, jobs, reports
  components/          UI and client components
  db/                  schema, Postgres/PGlite client, demo seeder
  lib/                 auth, authz, entitlements, money, finance, documents, storage,
                       malware, tenders, reconciliation, tasks, notifications, emails, jobs
scripts/               migrate, seed, reset-demo, run-jobs, storage-audit, fixtures
tests/                 auth, tenancy, finance, documents, storage, emails, tasks, plans,
                       reconciliation, XLSX fixtures, demo journey, migrations, PostgreSQL
drizzle/               generated SQL migrations
```

### Money and financial integrity

All amounts are integer minor units (`bigint`). Parsing rejects invalid precision (RWF has
no decimals). Invoice totals, balances, statuses and ageing are calculated server-side
from records; imports never modify financial tables.

### Authorization

`authorizeOrg()` resolves a role matrix (owner/staff/advisor/firm admin) plus active
advisor grants. Platform administrators have no implicit tenant access. Every entity
lookup is constrained by the authorized `orgId`; document downloads authorize against the
document's own organization, not the active-org cookie.

### Plans

Limits live in `src/lib/entitlements.ts` with optional `subscription_entitlements`
overrides. Document quotas use an organization row lock inside the same transaction as the
insert, preventing concurrent bypass. See `docs/PLANS.md`.

### Email and jobs

Messages are persisted in `email_outbox` before sending, retried with backoff and only
marked sent when the provider accepts the recipient. Reminders and retries run from
persisted state via `runScheduledJobs`, so restarts cannot lose work. See `docs/EMAIL.md`.

### Tender provenance

Every tender records source URL, source name, verification timestamp, importer and
provenance (`sample`, `manual_import`, `authorized_feed`). Relevance is a keyword score;
eligibility remains `unknown` until a human checks the official notice. Demo notices are
labelled `SAMPLE` and must not be bid on.

---

## Security summary

- Argon2id passwords; SHA-256-hashed session tokens; HttpOnly/SameSite cookies; Secure in
  production; login throttling.
- Single-use hashed verification/reset/invitation tokens with expiry; password changes
  revoke all sessions.
- CSRF: Next server-action origin checks + explicit Origin validation on state-changing
  API routes; SameSite=Lax cookies.
- Files: random org-scoped keys, signature checks, size limits, `0600` local files,
  streamed authorized downloads, optional ClamAV with fail-closed behaviour, audit events.
- Error logs redact SQL parameters, emails and secrets (`src/lib/logger.ts`).
- Audit events for auth, invitations, advisor grants/revocations, finance, documents,
  tenders, reconciliation, task changes and exports.

Known risks and pilot blockers are documented in `docs/SECURITY.md`.

---

## Documentation

- `docs/POSTGRES.md` — PostgreSQL 16.4 verification, CI configuration, local binaries
- `docs/EMAIL.md` — transports, outbox/retries, rate limits, Mailpit
- `docs/STORAGE.md` — S3/local, ClamAV, retention, backups
- `docs/PLANS.md` — plan limits and overrides
- `docs/OPERATIONS.md` — staging deploy, jobs, health, backup/restore, rollback, admin bootstrap
- `docs/DEMO.md` — 16-step customer demonstration and safe reset
- `docs/INTEGRATIONS.md` — tender/EBM scope and synthetic fixture formats
- `docs/SECURITY.md` — threat model and remaining risks
