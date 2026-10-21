# Staging operations

## Required environment

See `.env.example`. Minimum for staging:

```
NODE_ENV=production
APP_URL=https://staging.example.com
DATABASE_URL=postgres://app:...@db:5432/business_intelligence?sslmode=require
SESSION_TTL_DAYS=30
AUTH_DEV_EXPOSE_TOKENS=false
MFA_ENCRYPTION_KEY=<32-byte base64 or 64-hex>
MFA_REQUIRED_FOR=platform_admin   # add owner,firm_admin for the pilot
EMAIL_TRANSPORT=smtp
SMTP_URL=smtps://...
EMAIL_FROM="Ledgerline <no-reply@staging.example.com>"
STORAGE_DRIVER=s3            # or local with a persistent private volume
S3_BUCKET=...
S3_REGION=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
JOBS_SECRET=<long-random>
SEED_DEMO_DATA=false
```

`NODE_ENV=production` makes session cookies `Secure`, refuses registration when email
is not configured, and disables development token exposure.

## Deploy sequence

```bash
git fetch --all
git checkout <release-sha>
npm ci
npm run lint
npm run typecheck
npm test
npm run test:postgres          # in CI with TEST_DATABASE_URL
npm run build
pg_dump --format=custom --file=backup-$(date +%F-%H%M).dump "$DATABASE_URL"
npm run db:migrate
npm start                      # or restart the process manager
npm run jobs:run               # once, then schedule every 15 minutes
curl -fsS https://staging.example.com/api/health
```

Migrations are additive for the current release line, but always take a backup
before running them. Do not run destructive DDL automatically.

## Background jobs

All state lives in PostgreSQL (`email_outbox`, `notifications`, `rate_limits`,
`job_runs`). Choose one scheduler:

```cron
*/15 * * * * cd /srv/ledgerline && JOBS_SECRET=... npm run jobs:run >> /var/log/ledgerline-jobs.log 2>&1
```

or systemd timer:

```ini
[Timer]
OnUnitActiveSec=15min
OnBootSec=2min
[Install]
WantedBy=timers.target
```

or invoke the guarded endpoint:

```bash
curl -fsS -X POST https://staging.example.com/api/jobs/run \
  -H "Authorization: Bearer $JOBS_SECRET"
```

The endpoint returns 404 when `JOBS_SECRET` is unset. Never expose it without a secret.
Each run records a `job_runs` row with counts (reminders, sent/failed emails, recovered
stale sends).

## Health and monitoring

`GET /api/health` returns database reachability, storage driver, malware-scanner
configuration and email outbox counts. It never returns connection strings or secrets.

Alert on:

- HTTP 5xx rate and `/api/health` non-200;
- `email_outbox` rows failed or queued older than 30 minutes;
- `job_runs` last completed time older than 30 minutes;
- ClamAV availability when configured;
- disk usage for `UPLOAD_DIR` if using the local driver.

## Logs

Application errors are emitted as JSON by `src/lib/logger.ts`. SQL parameters
(amounts, emails, tokens) are dropped, emails are masked, and secrets are redacted.
Do not add request-body logging for financial endpoints. Reverse-proxy access logs
should exclude query strings that contain reset tokens.

## Initial platform administrator

There is intentionally no UI or bootstrap endpoint. Run this as a database
administrator after the person has registered and verified their email:

```sql
BEGIN;
SELECT id, email FROM users WHERE email = 'admin@example.com' FOR UPDATE;
UPDATE users SET is_platform_admin = true WHERE email = 'admin@example.com';
INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, metadata)
VALUES (gen_random_uuid()::text, 'admin@example.com', 'platform_admin.granted',
        'user', (SELECT id FROM users WHERE email = 'admin@example.com'),
        '{"method":"manual-dba-runbook"}'::jsonb);
COMMIT;
```

Platform admins see organization metadata only; they have no implicit access to books,
documents or tenders. Record who approved the change outside the database as well.

## Backup and restore

```bash
# database
pg_dump --format=custom --file=ledgerline.dump "$DATABASE_URL"
# local storage, if used
rsync -a --delete "$UPLOAD_DIR/" backup-host:/backups/ledgerline-uploads/

# restore (new empty database)
createdb business_intelligence_restore
pg_restore --no-owner --role=app --dbname=business_intelligence_restore ledgerline.dump
DATABASE_URL=postgres://.../business_intelligence_restore npm run db:migrate
```

For S3, rely on bucket versioning/replication and test object restoration. After a
restore, run `npm run storage:audit`, sign in as a test owner, download a document, and
run the health check.

## Rollback

1. Stop the app and job timer.
2. Deploy the previous release directory (`git checkout <previous-sha> && npm ci && npm run build`).
3. If the new migration was additive, the previous code can run against the same schema.
4. If a migration changed semantics, restore the pre-deploy database backup and object
   snapshot before starting the old release.
5. Restart jobs, verify health, and run the cross-tenant smoke check.

Never use `git reset --hard`, force-push, or drop the database as a rollback shortcut.

## Pre-pilot checklist

- [ ] HTTPS with HSTS at the proxy; cookies observed as `Secure`.
- [ ] `AUTH_DEV_EXPOSE_TOKENS=false`; no verification/reset links in responses.
- [ ] SMTP verified with a real message; SPF/DKIM/DMARC configured.
- [ ] Private storage verified; bucket not public; advisor revocation tested.
- [ ] ClamAV configured and a test upload scanned, or risk formally accepted.
- [ ] `JOBS_SECRET` set; scheduler running; job_runs recent.
- [ ] Backups automated and restore tested.
- [ ] Platform admin created via SQL and audit event recorded.
- [ ] Demo account isolated (`plan=demo`) or removed before real customer onboarding.
- [ ] Error logs checked for redaction.

See `docs/STAGING_VALIDATION.md` for the checks actually run against PostgreSQL, SMTP, S3-compatible storage and a real ClamAV daemon.
