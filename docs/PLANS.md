# Plans and entitlements

Plans are defined centrally in `src/lib/entitlements.ts` and are enforced server-side.

| Limit | free | demo | pilot | pro |
| --- | --- | --- | --- | --- |
| Organizations per owner | 1 | 3 | 3 | 10 |
| Team members (incl. pending invites) | 2 | 25 | 10 | 50 |
| Documents | 50 | 1,000 | 1,000 | 10,000 |
| Document storage | 100 MB | 5 GB | 2 GB | 50 GB |
| Saved opportunities | 3 | 100 | 50 | 500 |
| Advisor clients (firm) | 0 | 50 | 25 | 200 |
| Advanced CSV exports | no | yes | yes | yes |
| AI credits | 0 | 0 | 0 | 0 (no AI feature) |

Overrides live in `subscription_entitlements` using the same metric name as `feature`:

```sql
INSERT INTO subscription_entitlements (id, org_id, feature, enabled, limit_value)
VALUES (gen_random_uuid()::text, '<org-id>', 'documents_count', true, 250)
ON CONFLICT (org_id, feature) DO UPDATE SET limit_value = 250, enabled = true;
```

Setting `enabled=false` blocks the metric regardless of plan.

## Enforcement points

- Documents: count and bytes checked inside `withOrgQuota`, which locks the organization
  row and inserts in the same transaction. Verified under concurrency on PostgreSQL.
- Team: active members + pending invitations, checked when inviting and when accepting.
- Saved tenders: checked when saving a new opportunity.
- Advisor clients: distinct non-revoked clients per accounting firm, checked under a firm
  row lock when granting access.
- Organizations: owner's plan limit, checked under a user row lock.
- Advanced exports: enforced in the CSV route and reflected in the Reports UI.

Direct API calls cannot bypass these checks because every route/service resolves the
organization context first and the quota check is transactional. AI usage is exposed as an
entitlement but no AI feature is implemented, so no credits are consumed.

No payment gateway is integrated. Availability, fees and integration requirements have not
been verified, so upgrades are an operator action for the pilot.
