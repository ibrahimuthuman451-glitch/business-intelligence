# PostgreSQL verification

## Verified environment

- PostgreSQL **16.4** (x86_64 Linux), run in userspace for this verification.
- Migrations `0000_init.sql`, `0001_phase2_email_tasks_storage.sql` and `0002_mfa.sql` applied from an **empty database**.
- Full application suite executed against PostgreSQL 16.4: **133/133 tests passed** (18 files).
- PGlite run: **127 passed, 6 PostgreSQL-only tests skipped**.
- Dedicated PostgreSQL suite (`tests/postgres.integration.test.ts`): **6/6 passed**, covering:
  - server version assertion,
  - idempotent re-application of migrations,
  - transaction rollback leaving no partial writes,
  - concurrent payments serialized by `SELECT ... FOR UPDATE` (invoice cannot be overpaid),
  - concurrent inserts with the same invoice number (exactly one succeeds),
  - demo seed/reset idempotency and isolation from a real customer organization.

No PostgreSQL-specific behaviour is assumed by the PGlite suites: both drivers run the
same tests, and the failing PGlite-only assumption found during verification (result
shape from `db.execute`) was fixed in the test harness.

## Required configuration

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

- PostgreSQL 14+ required; 16.x is the verified version.
- Use a dedicated role for the app: `INSERT/SELECT/UPDATE/DELETE` on application tables,
  `USAGE` on sequences if any are added. Restrict `audit_events` to `INSERT/SELECT` for
  the app role if you want application-level immutability.
- TLS is required for managed providers; `postgres-js` honours `sslmode`.

## Local PostgreSQL (no Docker)

If Docker is unavailable, download the Zonky/PostgreSQL binaries used for this
verification and run them as your own user:

```bash
mkdir -p .pgbin && cd .pgbin
curl -sSLO https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/16.4.0/embedded-postgres-binaries-linux-amd64-16.4.0.jar
unzip -o embedded-postgres-binaries-linux-amd64-16.4.0.jar
# plus the .txz dependency, or use a distribution tarball
tar -xJf postgres-linux-x86_64.txz
```

Then:

```bash
export PATH="$PWD/.pgbin/bin:$PATH"
initdb -D "$PWD/.pgdata" -U postgres --auth=trust --no-locale -E UTF8
pg_ctl -D "$PWD/.pgdata" -o "-p 55432 -k $PWD/.pgdata -c listen_addresses=127.0.0.1" -l "$PWD/.pgdata/server.log" start
```

Create the database with the app's own driver (the minimal binary bundle omits `createdb`):

```bash
node --input-type=module -e "import postgres from 'postgres'; const s=postgres('postgres://postgres@127.0.0.1:55432/postgres'); await s.unsafe('create database bi_dev'); await s.end();"
DATABASE_URL=postgres://postgres@127.0.0.1:55432/bi_dev npm run db:migrate
```

## Docker / CI

`docs/ci-workflow.yml` (install it as `.github/workflows/ci.yml`) starts `postgres:16`, runs the PGlite suite, the same suite
with `TEST_DATABASE_URL`, the dedicated PostgreSQL suite, lint, typecheck, build, and
`npm audit --omit=dev --audit-level=high`.

`TEST_DATABASE_URL` must point at a database whose role can `CREATE DATABASE`; each test
file creates and drops its own throwaway database, so suites never share state.

## PGlite remains development-only

PGlite is single-writer and embedded. It stays available for fast local development and
unit tests, but staging and production must set `DATABASE_URL`.

See `docs/CI.md` for enabling the workflow (the workflow file requires GitHub `workflows` permission).

## Migrations from a pooled/serverless database

Set `MIGRATION_DATABASE_URL` to the direct or session-pooler URL for `npm run db:migrate`;
the application can use a transaction pooler in `DATABASE_URL` with
`DATABASE_PREPARE=false` and `DATABASE_POOL_MAX=3`.
