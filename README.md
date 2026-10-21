# Ledgerline — business intelligence workspace

A production-oriented SaaS foundation for Rwandan businesses and their accountants:
real books, private document rooms, verified tender intake, EBM-style file
reconciliation, tenant isolation and audit trails.

Built on the existing stack: **Next.js 16 (App Router) · React 19 · TypeScript ·
Drizzle ORM · PostgreSQL (or embedded PGlite for local development) · Vitest**.

---

## Status

| Area | State |
| --- | --- |
| Database models & migrations | Implemented (28 tables, constraints, indexes, FKs) |
| Authentication | Implemented: registration, login, logout, email verification, password reset, session revocation |
| Tenancy & permissions | Implemented server-side for every service; cross-tenant tests passing |
| Advisor access | Explicit client grant → invite acceptance → revocation, audited |
| Documents | Private storage, magic-byte validation, size limits, auth-checked downloads, review workflow, requests |
| Finance | Sales, expenses, customers, suppliers, invoices with server-calculated totals, payments, dashboard, ageing |
| Tenders | Manual verified import with provenance and source URL, filters, deadlines, relevance (not eligibility), bid checklists, labelled samples |
| Reconciliation | CSV/XLSX import, configurable column mapping, sales/purchases matching, traceable findings, human review |
| Live EBM / RRA integration | **Not implemented and not claimed.** File import only; no government credentials are collected |
| Live tender feed | **Not implemented and not claimed.** Verified manual import only |
| Transactional email | Not configured; links are logged server-side (see below) |
| Antivirus scanning | Not implemented (see remaining risks) |

---

## Quick start (local development)

Requirements: Node.js 22+ and npm. PostgreSQL is optional locally.

```bash
npm install
cp .env.example .env
npm run db:migrate      # applies ./drizzle migrations to embedded PGlite
npm run db:seed         # optional: labelled demo workspace
npm run dev             # http://localhost:3000
```

The embedded database lives in `.data/pglite` and is intended for development and
tests only. For a real deployment set `DATABASE_URL` to PostgreSQL 14+ and run
`npm run db:migrate` against it.

Demo login after seeding:

```
demo@ledgerline.local / DemoPassword9!
```

Every seeded record is prefixed `SAMPLE`, sample tenders carry `provenance=sample`,
and the organization plan is `demo`, which shows a persistent banner in the app.

### Useful commands

```bash
npm run lint            # ESLint (flat config)
npm run typecheck       # tsc --noEmit
npm test                # Vitest suite (in-memory PostgreSQL via PGlite)
npm run build           # production build
npm run db:generate     # generate a new SQL migration from schema.ts
npm run db:migrate      # apply migrations (Postgres or PGlite)
npm run db:seed         # demo data (refuses in production unless overridden)
```

---

## Production deployment

1. Provision PostgreSQL 14+ and set `DATABASE_URL`.
2. Set `APP_URL` to the public HTTPS origin and `NODE_ENV=production` (cookies
   become `Secure` automatically).
3. Set `UPLOAD_DIR` to a private volume **outside** the web root. Never expose it
   via nginx `alias`/static hosting; documents are streamed only through
   `/api/documents/:id/download` after an authorization check.
4. Run `npm run db:migrate` as a release step, then `npm run build && npm start`.
5. Keep `AUTH_DEV_EXPOSE_TOKENS=false`. Configure a real email provider by
   implementing `deliverEmail()` in `src/lib/request.ts`.
6. Put a reverse proxy in front of the app and forward `X-Forwarded-For`.

Health check: `GET /api/health` returns `{ status: "ok", database: "reachable" }`
when the database is up.

---

## Architecture

```
src/
  app/                 App Router pages, server actions, API routes
    app/               Authenticated workspace (dashboard, finance, docs, tenders…)
    api/               Health, private document download, reconciliation preview
    login|register|…   Authentication screens
  components/          Server/client UI components
  db/                  Drizzle schema, client (Postgres/PGlite), migrations config
  lib/                 Auth, authorization, money, finance, documents, storage,
                       tenders, reconciliation engine, CSV/XLSX parsing, audit
scripts/               migrate.ts, seed.ts
tests/                 Vitest suites (auth, tenancy, finance, documents, tenders, recon, migrations)
drizzle/               Generated SQL migrations
```

### Money

All amounts are stored as **integer minor units** (`amount_cents`) using bigint.
`src/lib/money.ts` parses user input, rejects unsupported precision (RWF has no
decimals), and calculates line and invoice totals server-side. Invoice status is
derived from recorded payments and due dates; the client never supplies totals.

### Authorization

Every service function takes an `OrgContext` produced by `authorizeOrg()`; there
is no path that trusts an organization id from the request without checking
membership or an active advisor grant. Document downloads resolve the document's
own org and authorize the actor against it, so switching the active-org cookie
cannot cross tenants.

Roles:

| Capability | Owner | Staff | Advisor | Firm admin | Platform admin |
| --- | --- | --- | --- | --- | --- |
| Read/write books | yes | yes | granted clients | granted clients | **no implicit access** |
| Review documents | yes | no | yes | yes | no |
| Manage team/advisor grants | yes | no | no | yes | no |
| Tender write | yes | yes | no | no | no |
| Audit log | yes | yes | yes (client) | yes | no |
| Organization metadata | yes | yes | yes | yes | metadata only, separate `/admin` |

Platform administrators deliberately receive **no** financial, document or tender
access. Their `/admin` page lists organization metadata only.

### Tender provenance

Tenders store `sourceUrl`, `sourceName`, `verifiedAt`, `provenance`
(`sample | manual_import | authorized_feed`) and the importing user. Relevance is
a keyword/sector score computed from the business profile; eligibility is always
reported as `unknown` until a human checks the official notice. No deadlines or
notices are generated by the system.

### Reconciliation

`src/lib/reconciliation-engine.ts` is a pure comparison engine (unit-tested).
Imports are stored as jobs with the raw row for every finding, and findings must
be accepted/resolved/dismissed by a human. Only CSV and XLSX are accepted. See
`docs/INTEGRATIONS.md` for what is and is not verified about EBM/RRA formats.

---

## Security model

- Argon2id password hashing; session tokens are random 256-bit values stored only
  as SHA-256 hashes in `sessions`.
- `HttpOnly`, `SameSite=Lax` cookies; `Secure` in production.
- Login throttling after repeated failures (database-backed audit window).
- Email verification and single-use password reset tokens (1 hour), which revoke
  all existing sessions on use.
- Server-side validation for every mutation; user-facing errors are sanitized.
- CSRF: server actions use Next.js origin protection; state-changing API routes
  validate `Origin`. Cookies are `SameSite=Lax`.
- Private files: random org-scoped storage keys, extension + magic-byte checks,
  10 MB default limit, `Content-Disposition: attachment`, `no-store`, sniffing
  protection. Download attempts are audit-logged.
- Audit events for auth, invitations, advisor grants/revocations, invoices,
  payments, documents (upload/download/review/delete), tenders, reconciliation.

See `docs/SECURITY.md` for the threat model and remaining risks.
