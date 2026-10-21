# Controlled customer demonstration

All demo records are fictional and prefixed `SAMPLE`. The organization plan is `demo`,
which shows a banner and enables exports without payment. Sample tenders are **not** real
procurement notices and must never be bid on.

## Credentials (created by `npm run db:seed`)

| Role | Email | Password |
| --- | --- | --- |
| Business owner | `demo@ledgerline.local` | `DemoPassword9!` |
| Advisor (Demo Advisory Firm) | `advisor@demo-firm.local` | `DemoPassword9!` |

## Reset safely

```bash
npm run demo:reset
```

This removes only the demo organizations (identified by the demo users and the
`sample-%` slugs), their records and demo audit events, then recreates them. Real
customer organizations are untouched; this is covered by a PostgreSQL test.

## Journey script

1. Sign in as the business owner at `/login`.
2. Dashboard shows revenue, receivables, tax position and ageing computed from sample records.
3. Record a sale in **Sales** and an expense in **Expenses**.
4. Return to the dashboard; revenue and costs changed from the database.
5. Open **Invoices** → `SAMPLE-INV-001`; note the partial payment and balance.
6. Open **Team & advisors**; the advisor authorization is active. (To demonstrate the
   pending → accept flow, revoke and re-grant, then open the development invite link.)
7. Sign out and sign in as the advisor. The banner states access is client-authorized.
8. The advisor sees the same books but no team management.
9. **Document requests** contains the seeded March request; create another if desired.
10. Sign back in as the owner, upload a PDF in **Documents**; it is stored privately.
11. As the advisor, download it, approve it with a review note, and confirm the owner receives an in-app notification.
12. Open **Reconciliation**, import `tests/fixtures/sales-standard.csv` (or the demo CSV),
    map columns and run. Open the job to show a traceable finding; accept or resolve it.
13. Open **Tender intelligence**; the sample notice is labelled `sample` with source URL,
    verification time and the explicit warning. Assess fit and complete checklist items.
14. **Tasks** shows seeded tasks including an overdue one; complete a task.
15. **Reports & exports** downloads a CSV containing `SAMPLE` rows.
16. In a private window, create a second organization and confirm it cannot open the
    demo document URL or invoices (403/404).

## Talking points and limits

- Relevance is not eligibility; eligibility remains `unknown` until checked against the
  official notice.
- No live tender feed and no EBM/RRA connection exist; imports are files only.
- Demo emails use the file transport unless SMTP is configured; links appear in the UI in
  development.
- Financial reports are management information, not statutory filings.
