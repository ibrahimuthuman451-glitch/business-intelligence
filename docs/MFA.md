# Multi-factor authentication (TOTP)

## What is implemented

- TOTP (RFC 6238, SHA-1, 6 digits, 30-second step) compatible with Google
  Authenticator, Microsoft Authenticator, 1Password and similar apps.
- Secrets are encrypted at rest with AES-256-GCM (`MFA_ENCRYPTION_KEY`).
- Ten single-use recovery codes are shown once at enrollment and stored as keyed
  HMAC-SHA256 hashes, never in plaintext.
- Enrollment requires a valid code before MFA becomes active.
- Login creates a short-lived, single-use challenge (hashed token, five-minute
  expiry, five attempts). No session cookie is issued until the second factor passes.
- Replay protection persists the last accepted TOTP time step per user.
- Password reset / password change revoke sessions; disabling MFA revokes every session.
- Audit events: `mfa.setup_started`, `mfa.enrolled`, `mfa.verified`, `mfa.failed`,
  `mfa.replay_rejected`, `mfa.recovery_used`, `mfa.disabled`. Secrets and codes are never
  included in audit metadata.

## Configuration

```bash
# Generate once and store in the secret manager; do not commit or log.
MFA_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# Optional policy. Default is platform_admin.
# Comma list of: owner,staff,advisor,firm_admin,platform_admin; 'all' or 'none'.
MFA_REQUIRED_FOR=platform_admin,owner,firm_admin
```

The key must be 32 bytes encoded as standard base64 or 64 hex characters. Losing the
key makes existing TOTP secrets unreadable and users cannot sign in with TOTP. Back it
up in the same secret manager as other production secrets. Key rotation is not automated:
re-enroll users before replacing the key (or use a controlled database runbook below).

If `MFA_ENCRYPTION_KEY` is missing, MFA setup is unavailable and any MFA-enabled user is
refused at login; this fails closed. If a role is required by policy and the key is
missing, login is refused with an operator-facing error.

## User flows

- **Enable (settings → Two-step verification)**: current password → scan/enter the secret
  → confirm a code → save the ten recovery codes. Other sessions are revoked.
- **Sign in**: password → challenge page → TOTP or one recovery code. Each recovery code
  works once.
- **Lost device**: sign in with a recovery code, then disable MFA with password + a code and
  enroll the new device. If all codes are lost, an administrator must use the runbook
  below after identity verification.
- **Disable**: current password + valid TOTP/recovery code. Roles required by policy cannot
  disable MFA.
- **Required role without enrollment**: the password login is converted into a ten-minute
  enrollment challenge; no application session is created until MFA is confirmed.

## Administrator requirement and recovery

Set `MFA_REQUIRED_FOR` before onboarding privileged accounts. Login then forces enrollment
for those roles. To recover an account after all factors and recovery codes are lost,
verify the user's identity out of band, then as a database administrator:

```sql
BEGIN;
UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL,
  mfa_enrolled_at = NULL, mfa_last_step = 0
WHERE email = 'user@example.com';
DELETE FROM mfa_recovery_codes
WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');
DELETE FROM mfa_challenges
WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');
INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, metadata)
VALUES (gen_random_uuid()::text, 'dba@example.com', 'mfa.admin_reset', 'user',
  (SELECT id FROM users WHERE email = 'user@example.com'),
  '{"reason":"identity-verified-lost-device"}'::jsonb);
COMMIT;
```

The user must enroll again. Record the ticket and approver outside the database.

## Tests

`tests/mfa.test.ts` covers the RFC vector, encrypted-at-rest storage, wrong password,
confirmation, replay, invalid codes, recovery-code single use, disablement, policy
refusal, privileged access gating, missing/tampered keys, challenge expiry/attempt limits
and absence of secrets in audit metadata.

## Limitations

- TOTP only; no WebAuthn/security keys or push approvals.
- No self-service “reset all factors” email; recovery is by code or operator runbook.
- Key rotation requires re-enrollment.
- Rate limits are per-account and per-IP in the application; add a gateway limit for
  distributed attacks.
