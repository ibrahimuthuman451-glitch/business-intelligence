# Continuous integration

The workflow is maintained at `docs/ci-workflow.yml`. It was **not** pushed to
`.github/workflows/ci.yml` because the GitHub App used in this environment lacks the
`workflows` permission; the push was rejected by GitHub. This is an environment
permission policy, not a code failure.

## What the workflow does

- `npm ci` from the committed lockfile.
- ESLint and `tsc --noEmit`.
- Starts PostgreSQL 16 as a service.
- Creates `business_intelligence`, then runs `npm run db:migrate` against PostgreSQL.
- Runs the PGlite suite and the same suite with `TEST_DATABASE_URL` (PostgreSQL).
- Builds the production application.
- Fails on high/critical production dependency advisories.
- Uploads test logs only on failure (no secrets are in the logs).

## How a repository owner enables it

1. Open **Settings → Actions → General** and allow GitHub Actions for the repository.
2. Copy `docs/ci-workflow.yml` to `.github/workflows/ci.yml` using one of:
   - the GitHub web editor (owner has workflow permission), or
   - a classic personal access token with the `workflow` scope, or
   - a GitHub App installation granted **Workflows: Read and write**.
3. Commit the file to the working branch and push.
4. In **Settings → Branches**, protect the target branch and require the `verify` check.
5. Open a pull request and confirm the workflow runs lint, both test suites, migration,
   build and the production audit.

Run the same steps locally before opening the PR:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
npm run test:postgres
npm run build
```
