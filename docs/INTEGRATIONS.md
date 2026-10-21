# Tender sources and EBM reconciliation

## Tender sources — what was actually done

No authorized live integration with a procurement portal was available in this
environment, and no credentials or API agreements were provided. We therefore did
**not** invent one, and the product does not claim live ingestion.

Implemented instead:

- Verified **manual import** of a notice the user has opened on an official source.
- Required fields: official reference, title, closing date/time, source URL
  (http/https enforced by validation and a database check constraint).
- Stored provenance: `sourceUrl`, source name, `verifiedAt`, importing user and
  `provenance='manual_import'`.
- Duplicate references per organization are rejected.
- Sample/demo notices are stored with `provenance='sample'` and titles prefixed
  `SAMPLE`; the UI warns that they are not real notices.
- Relevance scoring (business sector, city, keywords) is shown separately from
  eligibility, which remains `unknown` until a human verifies mandatory
  requirements in the official notice.

To add a live feed later, only implement it after obtaining written permission
from the source and testing it. Use `provenance='authorized_feed'`, keep the
source record, and never scrape sources whose terms prohibit it. Public sources in
Rwanda include RPPA and the UMUCYO e-procurement portal; access terms and any API
or data-export permission must be verified with the operator before integration.

## EBM / RRA — what is verified

No EBM or RRA integration is implemented or claimed. No authorization was obtained
and no live endpoint was called. The application **never** asks for or stores
government portal passwords.

What exists is file-based reconciliation:

- Import a sales or purchases report as CSV or XLSX.
- Confirm a column mapping (invoice/reference, amount, optional date).
- Compare against invoices (sales) or expenses with a supplier reference
  (purchases).
- Findings: `MISSING_IN_SYSTEM`, `AMOUNT_MISMATCH`, `DUPLICATE_ROW`,
  `INVALID_AMOUNT`, `MISSING_REFERENCE`, `DATE_MISMATCH`.
- Every finding stores the raw row, row number, expected/actual amounts and is
  reviewed by a human (`accepted`, `resolved`, `dismissed`).

Column names are matched heuristically (English and French aliases) but always
confirmed by the user. Because no official EBM export specification was available
to test against, treat the mapping as configurable rather than certified. Before
marketing this as EBM-compatible, obtain sample exports from RRA/EBM and add
fixtures to `tests/reconciliation.test.ts`.

If RRA later authorizes a VSDC or API integration, implement it server-side with
organization-scoped credentials issued to the business, store only the minimum
secrets in a secrets manager, and never accept user government passwords.
