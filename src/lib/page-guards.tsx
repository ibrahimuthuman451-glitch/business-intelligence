import { Alert, PageHeader } from "@/components/ui";
import { isDatabaseUnavailable } from "./db-errors";
import { AppError } from "./errors";
import { logServerError } from "./logger";

export function serviceUnavailable(error: unknown, area: string) {
  const message = error instanceof AppError ? error.message : null;
  if (isDatabaseUnavailable(error)) {
    return (
      <>
        <PageHeader title="Database not ready" description="The workspace could not reach its database." />
        <Alert tone="error">
          Run <code>npm run db:migrate</code> and restart the application. If this is a production
          deployment, check <code>DATABASE_URL</code>.
        </Alert>
      </>
    );
  }
  logServerError(`page_load:${area}`, error);
  return (
    <>
      <PageHeader title="Something went wrong" description="This page could not be loaded." />
      <Alert tone="error">{message ?? "An unexpected error occurred. Please try again."}</Alert>
    </>
  );
}
