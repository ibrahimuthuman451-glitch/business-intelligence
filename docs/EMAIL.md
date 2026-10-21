# Email delivery

## Modes

| `EMAIL_TRANSPORT` | Use | Behaviour |
| --- | --- | --- |
| `smtp` | Staging/production | Sends through `SMTP_URL`; only reports `sent` when the provider accepts the recipient. |
| `file` | Local development | Writes JSON messages to `MAIL_OUTBOX_DIR` and exposes links in the UI when `NODE_ENV !== production`. |
| `disabled` | Misconfiguration fallback | Fails safely; registration is refused in production and the failure is audited. |

Required for SMTP:

```
EMAIL_TRANSPORT=smtp
SMTP_URL=smtps://USER:PASSWORD@smtp.provider.example:465
EMAIL_FROM="Ledgerline <no-reply@your-domain.example>"
APP_URL=https://staging.your-domain.example
```

Use a provider-specific app password or SMTP credential, never a mailbox password.
Keep credentials in the platform secret manager; they are not read from source files.

## Local testing

Either open the JSON files written under `.data/mail-outbox/`, or run Mailpit:

```bash
docker run --rm -p 1025:1025 -p 8025:8025 axllent/mailpit
# .env
EMAIL_TRANSPORT=smtp
SMTP_URL=smtp://127.0.0.1:1025
EMAIL_FROM="Ledgerline Dev <dev@ledgerline.local>"
```

Mailpit's web UI is at `http://localhost:8025`. The application never enables the
file transport automatically in production.

## Reliable delivery model

- Every message is written to `email_outbox` before any network call.
- A worker claims a row with a conditional status update, so two workers cannot
  send the same attempt concurrently.
- Transient SMTP failures (4xx, connection/timeouts) are retried with exponential
  backoff (`EMAIL_BACKOFF_SECONDS`, default 60 s) up to `EMAIL_MAX_ATTEMPTS` (5).
- Permanent failures are marked `failed` and are never reported as delivered.
- A message stuck in `sending` for more than 15 minutes is recovered by the next
  scheduled job. Delivery is therefore **at-least-once**: if the process dies after
  the provider accepts but before the row is marked sent, it can be sent twice.
- `processEmailOutbox` is invoked by `npm run jobs:run` and `POST /api/jobs/run`
  (guarded by `JOBS_SECRET`). No in-memory timers are used, so restarts are safe.

## Workflows and tokens

| Email | Trigger | Token behaviour |
| --- | --- | --- |
| Verification | Registration / resend | 24 h, single use, stored hashed |
| Password reset | Forgot password | 1 h, single use, revokes all sessions on use |
| Staff invitation | Owner/firm admin invites | 7 days, single use, email-bound |
| Advisor authorization | Client grants advisor access | 7 days, single use, email-bound, pending until accepted |
| Document request | Advisor/business creates a request | In-app + email to organization members |
| Task assignment / due | Task created or scheduled job | In-app + email to assignee |
| Tender deadline | Scheduled job (7-day window) | In-app + email, deduplicated per UTC day |

Rate limits (fixed windows, atomic counters in `rate_limits`):

- password reset: 3 per email/hour and 10 per IP/hour;
- resend verification: 3 per user/hour.

## What the operator must verify

1. Send a test verification and reset email from staging and confirm arrival.
2. Check SPF, DKIM and DMARC for the sending domain.
3. Watch `GET /api/health` (`email.queued`, `email.failed`).
4. Never expose mailbox contents or SMTP credentials in logs or support tickets.

## Automated coverage

`tests/email.test.ts` covers provider acceptance, deduplication, transient retry and
backoff, permanent failure, attempt exhaustion, unconfigured transport failure,
rate limiting under concurrency, token expiry and token non-leakage.
