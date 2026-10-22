# One-command Windows setup

This helper automates the repetitive part after you have created the free accounts. It does
not create accounts, pay for resources, or log in on your behalf.

## What you must do first (once)

1. Create a **Supabase Free** project.
2. Create a **private** Storage bucket named `ledgerline-private`.
3. Enable Storage → S3 and generate access keys.
4. Create a **Brevo Free** account, verify a sender, and generate an SMTP key.
5. Create a **Vercel** account and log in to the CLI on Windows:

```powershell
npx --yes vercel@latest login
```

The script can run without Vercel login using `-NoDeploy`, but it cannot deploy until the
CLI is authenticated.

## Run

From the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows-setup.ps1
```

The script asks for:

- Vercel project name and public app URL (default `https://<project>.vercel.app`)
- Supabase transaction pooler URL (runtime) and session pooler URL (migrations)
- S3 bucket, region, endpoint, access key and secret
- Brevo SMTP URL and verified `EMAIL_FROM` (you may leave SMTP blank for a demo; registration will be disabled)
- Optional mailbox for one SMTP verification message
- MFA policy

It generates `MFA_ENCRYPTION_KEY` and `JOBS_SECRET` if they are not already saved, writes
all deployment values to **`.env.deploy.local`** (git-ignored, contains secrets), then:

1. installs dependencies,
2. applies migrations with the session pooler URL,
3. resets the demo workspace into Supabase (SAMPLE records, private S3 documents),
4. verifies private S3 access and the anonymous-access check,
5. sends one SMTP verification if you supplied a mailbox,
6. builds the app locally,
7. creates/links the Vercel project and sets production environment variables,
8. deploys to Vercel production.

It never prints secret values. Do not share `.env.deploy.local`.

## Prepare only (no Vercel deploy)

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows-setup.ps1 -NoDeploy
```

or skip optional steps:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows-setup.ps1 -SkipSmtp -SkipBuild
```

## After it finishes

1. Open the deployment URL printed by Vercel.
2. Check `https://<app>/api/health`: `status ok`, `storage s3`, `storageReady true`.
3. Sign in with the sample owner or advisor (see `docs/DEMO.md`).
4. Create the cron-job.org job:
   - POST `https://<app>/api/jobs/run`
   - Header `Authorization: Bearer <JOBS_SECRET>`
   - Every 15 minutes
5. If Vercel gave a different URL, update `APP_URL` in Vercel and redeploy.

## If something fails

- **Vercel login:** run `npx --yes vercel@latest login` and rerun.
- **S3 public check:** stop. Make the Supabase bucket private and re-run `npm run verify:s3`.
- **SMTP:** verify the Brevo sender/account approval; the script will stop before deploy if
  the verification email fails.
- **Supabase pause:** a Free project pauses after a week without activity; the cron job
  keeps it active but is not a service-level guarantee.
- **No ClamAV:** Vercel cannot run ClamAV; uploads are marked `not_scanned`. Do not claim
  malware protection for the demo.

## Cost/terms warning

Vercel Hobby is free but **non-commercial**. For a customer-facing sales demo or a paid
pilot, upgrade to Vercel Pro (verified $20/developer/month) and consider Supabase Pro
(from $25/month) for no pausing and backups. Brevo Free is 300 emails/day; cron-job.org is
free. No paid resource is created by this script.
