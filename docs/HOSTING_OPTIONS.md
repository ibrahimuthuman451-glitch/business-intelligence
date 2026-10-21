# Hosting options (verified 21 Oct 2026)

Prices and limits below are copied from provider documentation on 21 Oct 2026. Provider
terms and limits change; re-check before creating resources. No paid resource was created
for this report.

## Free development/demo hosting

| Service | Free offer | Limits relevant to this app |
| --- | --- | --- |
| **Vercel Hobby** | $0 | Node functions (SMTP allowed on 465/587, port 25 blocked); 300 s max duration; **4.5 MB request body**; 100 GB transfer; **non-commercial personal use only**; built-in cron only **once per day**. |
| **Supabase Free** | $0 | 500 MB database, 1 GB file storage, 5 GB egress; **projects pause after 1 week of inactivity**; 2 active projects; S3-compatible Storage available; no card requirement is stated on the pricing page (confirm at signup). |
| **Neon Free** | $0 | 1 GB storage/project (20 GB account), 100 CU-hours/project, 5 GB transfer; scale-to-zero after 5 min. Separate object storage needed. |
| **Cloudflare R2 Free** | $0 within 10 GB-month | 1M Class A + 10M Class B operations; free egress; S3 API; **does not support the SSE `x-amz-server-side-encryption` header**; payment-method policy must be confirmed at signup. |
| **Brevo Free** | $0 | Up to **300 emails/day** after account approval; SMTP relay included; sender verification required; no credit card per FAQ. |
| **cron-job.org Free** | $0 | 1-minute minimum interval; arbitrary custom headers; 30-second request timeout; no account job limit under fair use. |
| **Render Hobby** | $0 | 512 MB web service, spins down on idle, **free PostgreSQL expires after 30 days**, free web services **cannot send SMTP on 25/465/587**; not suitable for this email path. |

## Production hosting

| Service | Verified price | Notes |
| --- | --- | --- |
| **Vercel Pro** | **$20/developer/month** | Removes Hobby non-commercial restriction; cron up to every minute; 300 s functions; 4.5 MB body. |
| **Supabase Pro** | **from $25/month** | No project pausing, 8 GB database disk included, 100 GB storage, daily backups (7 days), custom domain extra. |
| **Render Starter** | **$7/month** compute | Paid web service; free tier SMTP restriction does not apply by implication, but paid SMTP-port policy was **not verified**; free DB expires. |
| **Brevo** | Free tier; paid plans separately priced | Free 300/day; upgrade only when volume requires. |
| **ClamAV host** | Not free on Vercel | Needs a persistent VM/container with TCP access; cost depends on provider; no scanner is better than a false claim. |

## Recommended architecture

### Zero-cost demo (non-commercial, invitation-only)

```
Vercel Hobby (Next.js app)  $0
  |-- Supabase Free PostgreSQL (transaction pooler at runtime)  $0
  |-- Supabase Free private Storage bucket (S3 endpoint)          $0
  |-- Brevo Free SMTP (300/day)                                   $0
  +-- cron-job.org -> POST /api/jobs/run every 15 min             $0
```

This keeps **PostgreSQL and private object storage**; no PGlite and no ephemeral disk.
Use `MAX_UPLOAD_BYTES=4194304` because Vercel caps request bodies at 4.5 MB.
ClamAV cannot run in a Vercel function; uploads are marked `not_scanned` unless a remote
daemon is configured. Demo documents are synthetic; do not claim malware protection.

**Vercel Hobby is non-commercial.** It is acceptable for a private prototype/portfolio
demo, not for a customer-facing sales demo or a paid pilot. For a commercial demo or pilot,
use Vercel Pro ($20/month) and, when real customer data is stored, Supabase Pro
(from $25/month) for no pausing and backups.

### Lowest predictable paid pilot

```
Vercel Pro $20/mo + Supabase Free (upgrade to Pro when >500 MB / 1 GB or SLA needed)
+ Brevo Free + cron-job.org (or Vercel Pro cron every 15 min)
+ a separate ClamAV VM only if uploads from untrusted users are enabled
```

This is roughly **$20/month** while within Supabase Free limits; **$45/month** with
Supabase Pro. Vercel Pro includes 1M function invocations and 4 CPU-hours; Supabase Pro
includes 8 GB database and 100 GB storage. These are verified list prices, excluding tax
and any domain registration.

### Not recommended for this app

- **Render Hobby** for the demo: free web services cannot send SMTP on 465/587 and its
  free PostgreSQL expires after 30 days. Paid Render SMTP policy was not verified.
- **Render free PostgreSQL** for any persistent data: 30-day expiry, no backups.
- **PGlite / local disk** on a serverless host: lost on redeploy/cold start; the app now
  refuses local storage when `VERCEL` is set.
- **Cloudflare R2** as the first choice for the zero-cost demo: free capacity is larger,
  but it does not support the SSE header and its payment-method requirement was not
  confirmed. The S3 driver now omits SSE when `S3_SERVER_SIDE_ENCRYPTION` is empty.
- **Oracle/Fly/Railway free tiers** as the primary recommendation: either not free at
  current terms, require a card, or demand more Linux operations than a Windows-based
  owner should take on for a demo.

## Sources checked

- Vercel Hobby limits and non-commercial restriction: https://vercel.com/docs/plans/hobby
- Vercel function body/duration limits: https://vercel.com/docs/functions/limitations
- Vercel cron frequency limits: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Vercel SMTP port policy: https://vercel.com/kb/guide/serverless-functions-and-smtp
- Supabase Free limits and pausing: https://supabase.com/pricing and https://supabase.com/docs/guides/platform/billing-faq
- Supabase S3 endpoint/credentials: https://supabase.com/docs/guides/storage/s3/authentication
- Supabase S3 compatibility (no SSE header/checksums): https://supabase.com/docs/guides/storage/s3/compatibility
- Brevo free 300/day + SMTP: https://www.brevo.com/pricing/
- cron-job.org free scheduling/custom headers/30-second timeout: https://cron-job.org/en/faq/
- Render free limits and SMTP port block: https://render.com/docs/free
- Neon Free plan: https://neon.com/docs/introduction/plans
- Cloudflare R2 free tier and S3 compatibility: https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/r2/api/s3/api/
