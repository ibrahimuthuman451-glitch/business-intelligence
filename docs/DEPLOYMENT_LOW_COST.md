# Windows deployment guide — Vercel + Supabase (zero-cost demo)

This guide deploys the existing app without rebuilding it. It uses Supabase Free for
PostgreSQL **and private object storage**, Vercel Hobby for the Next.js app, Brevo Free
for SMTP, and cron-job.org for the 15-minute job schedule.

> **Do not start here if you have not approved creating accounts/resources.** The
guide is written for you to execute manually. No deployment or DNS change was performed
by the assistant.

## 1. Accounts you must create (all free tiers)

1. GitHub account with this repository (existing).
2. Vercel account (GitHub login is fine).
3. Supabase account.
4. Brevo account and sender verification (or a Gmail app password for a throwaway demo).
5. cron-job.org account (optional; needed for 15-minute reminders).

No credit card is stated as required for Vercel Hobby or Brevo Free. Supabase's pricing
page advertises a $0 Free plan; confirm its current signup requirements. R2 is not used.

## 2. Create Supabase project and database

1. Create a project in a region near your users (for Rwanda, an EU region is usually
   better than US). Save the database password in a password manager.
2. Open **Project Settings → Database → Connection string**. Copy **both**:
   - **Transaction pooler** string (port 6543) for Vercel runtime.
   - **Session pooler** string (port 5432) for migrations from Windows.
   The direct connection may be IPv6-only unless the paid IPv4 add-on is enabled; the
   session pooler works over IPv4.
3. Open **SQL Editor** and confirm the project is ready.

## 3. Create private Storage bucket and S3 credentials

1. **Storage → New bucket**: name `ledgerline-private`, keep it **private** (no public
   bucket, no public bucket policy).
2. **Storage → Settings → S3 protocol**: enable it, copy the endpoint and region, and
   generate an S3 access key pair. The endpoint looks like:
   `https://<project-ref>.storage.supabase.co/storage/v1/s3`.
3. Record:
   - `S3_BUCKET=ledgerline-private`
   - `S3_REGION=<region shown by Supabase>`
   - `S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3`
   - `S3_ACCESS_KEY_ID=...`
   - `S3_SECRET_ACCESS_KEY=...`
   - `S3_FORCE_PATH_STYLE=true`
   - leave `S3_SERVER_SIDE_ENCRYPTION` **empty** (Supabase rejects that header)

## 4. Create SMTP credentials

Brevo: create an account, verify a sender email/domain, open **SMTP & API → SMTP**, and
create an SMTP key. Then set:

```
EMAIL_TRANSPORT=smtp
SMTP_URL=smtp://YOUR_BREVO_LOGIN:YOUR_SMTP_KEY@smtp-relay.brevo.com:587
EMAIL_FROM="Ledgerline <verified-sender@example.com>"
```

Port 465 with `smtps://` is also supported by Vercel and Nodemailer. Brevo Free is
300 emails/day after approval. If your account cannot be approved for arbitrary
recipients, use a Gmail account with 2-Step Verification and an App Password for a
throwaway demo, and replace it before a pilot.

Never put these values in Git or a screenshot.

## 5. Generate secrets on Windows (PowerShell)

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # MFA_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" # JOBS_SECRET
```

Store them in a password manager. Losing `MFA_ENCRYPTION_KEY` makes MFA accounts unable
to use their authenticator; back it up.

## 6. Apply database migrations from Windows

Open PowerShell in the repository. Use the **session pooler** URL for migration (not the
transaction pooler):

```powershell
npm ci
$env:MIGRATION_DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
npm run db:migrate
```

Do not run `db:seed` yet. Verify with Supabase Table Editor that tables such as `users`,
`organizations`, `documents`, `email_outbox` exist.

> If your Supabase dashboard gives a different session-pooler hostname/port, use exactly
the value it shows. Do not paste passwords into shared terminals.

## 7. Deploy to Vercel

1. Push this branch to GitHub (the assistant already committed; you must push/approve).
2. Vercel → **Add New → Project** → import the repository → framework **Next.js**.
3. Add environment variables for **Production** (and optionally Preview):

```
APP_URL=https://<project>.vercel.app
DATABASE_URL=<transaction pooler URL, port 6543, sslmode=require>
DATABASE_PREPARE=false
DATABASE_POOL_MAX=3
STORAGE_DRIVER=s3
S3_BUCKET=ledgerline-private
S3_REGION=<Supabase region>
S3_ENDPOINT=https://<ref>.storage.supabase.co/storage/v1/s3
S3_ACCESS_KEY_ID=<hidden>
S3_SECRET_ACCESS_KEY=<hidden>
S3_FORCE_PATH_STYLE=true
EMAIL_TRANSPORT=smtp
SMTP_URL=smtp://<brevo-login>:<smtp-key>@smtp-relay.brevo.com:587
EMAIL_FROM=Ledgerline <verified-sender@example.com>
MFA_ENCRYPTION_KEY=<generated>
MFA_REQUIRED_FOR=platform_admin
JOBS_SECRET=<generated>
AUTH_DEV_EXPOSE_TOKENS=false
MAX_UPLOAD_BYTES=4194304
SEED_DEMO_DATA=false
```

Do **not** set `PGLITE_DIR`, do not set `STORAGE_DRIVER=local`, and do not set
`EMAIL_TRANSPORT=file`.
4. Deploy. Vercel runs `next build`; migrations are not run automatically.
5. After the first deployment, set `APP_URL` to the real URL and redeploy so cookies,
   links and origin checks use the right host.

## 8. Seed the sample workspace safely

Run this from Windows against Supabase, using the **session pooler** for data operations
and the S3 credentials. `SEED_DEMO_DATA=true` is required because `NODE_ENV` is production
and the reset script is intentionally guarded.

```powershell
$env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
$env:STORAGE_DRIVER = "s3"
$env:S3_BUCKET = "ledgerline-private"
$env:S3_REGION = "<region>"
$env:S3_ENDPOINT = "https://<ref>.storage.supabase.co/storage/v1/s3"
$env:S3_ACCESS_KEY_ID = "<hidden>"
$env:S3_SECRET_ACCESS_KEY = "<hidden>"
$env:S3_FORCE_PATH_STYLE = "true"
$env:EMAIL_TRANSPORT = "disabled"   # no need to email fictional demo addresses during seeding
$env:SEED_DEMO_DATA = "true"
$env:NODE_ENV = "production"
npm run demo:reset
```

This deletes and recreates **only demo-owned organizations** (the demo users' owned
organizations and global `SAMPLE-%` tenders); the PostgreSQL test proves a real customer
organization survives. The seeded documents go to the private Supabase bucket because
`STORAGE_DRIVER=s3` is set.

Demo logins (fictional):

```
owner:   demo@ledgerline.local / DemoPassword9!
advisor: advisor@demo-firm.local / DemoPassword9!
```

If you enable `MFA_REQUIRED_FOR=owner`, the demo owner will be forced to enroll; set it
before the demo and have an authenticator ready, or leave the default `platform_admin`.

## 9. Schedule jobs

Vercel Hobby cron cannot run more often than once per day. Create a cron-job.org job:

- URL: `https://<project>.vercel.app/api/jobs/run`
- Method: **POST**
- Schedule: every **15 minutes**
- Header: `Authorization: Bearer <JOBS_SECRET>`
- Enable failure notifications.

cron-job.org supports custom headers and POST (verified in its FAQ); its timeout is 30 s,
so keep the demo volume small. For production, use Vercel Pro cron or a real worker.

## 10. Verify after deployment

```text
GET  /api/health
  status ok, database reachable, storage s3, storageReady true
  email transport smtp/configured true (unless deliberately disabled)
  mfa encryptionConfigured true

GET  /login
POST /login (owner) -> 303 to dashboard, Set-Cookie Secure; HttpOnly; SameSite=lax
GET  /app/dashboard, /app/documents, /app/tenders, /app/tasks, /app/reports -> 200
POST /api/jobs/run with Bearer JOBS_SECRET -> 200
GET  /api/jobs/run without secret -> 401
```

Run the external checks from Windows too:

```powershell
# Set the same deployment env values in this shell, then:
npm run verify:smtp   # requires VERIFY_EMAIL_TO set to your own mailbox
npm run verify:s3
npm run storage:audit
```

`verify:s3` must report an anonymous GET status of 403/404. Supabase storage is private;
if it returns 200, stop and fix the bucket policy.

`verify:clamav` cannot run on Vercel unless you have a separate reachable ClamAV daemon;
without it, uploads show `not_scanned`. Do not tell customers that malware scanning is
active.

## 11. Custom domain

1. Buy/own a domain (cost depends on registrar; not verified here).
2. Vercel → Project → Domains → add the domain and follow DNS instructions.
3. Update `APP_URL` to `https://your-domain.example` and redeploy.
4. Email sender verification is separate (Brevo dashboard); do not change MX records for
   a domain you use for receiving mail without understanding the impact.

## 12. Rollback

1. Vercel → Deployments → select the last known-good deployment → **Promote/Rollback**.
2. Database migrations in this release are additive; the previous app can generally run
   on the new schema. If a migration is not backward-compatible, restore the Supabase
   backup/dump before rolling back code.
3. Supabase Free has no daily backup guarantee. Before migrating, run `pg_dump` from
   Windows with the session pooler URL; keep the dump outside Git.
4. Do not reset the demo on a real customer project; use a separate Supabase project for
   customer data and the demo project for `SAMPLE` records.

## 13. Known limitations of this zero-cost deployment

- Vercel Hobby is **non-commercial**; upgrade to Pro before a customer-facing sales demo
  or paid pilot.
- Supabase Free pauses after a week without activity, has 500 MB DB and 1 GB storage;
  the 15-minute cron should keep it active, but this is not an SLA.
- Vercel caps request bodies at 4.5 MB; the app caps uploads at 4 MB on Vercel.
- No ClamAV on Vercel; uploads are unscanned unless you configure a remote daemon.
- SMTP delivery depends on Brevo approval/sender verification; Vercel allows ports
  465/587 but blocks 25 (verified).
- Cron-job.org has a 30-second timeout; a large reminder/email backlog may exceed it.
- Free-tier provider terms and limits can change; verify before the demo.
