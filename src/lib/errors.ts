/** Error carrying an HTTP status and a message that is safe to show to users. */
import { logServerError } from "./logger";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "bad_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  readonly details?: unknown;

  constructor(message = "The submitted data is invalid", details?: unknown) {
    super(message, 422, "validation_error");
    this.name = "ValidationError";
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "You must sign in to continue") {
    super(message, 401, "unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super(message, 403, "forbidden");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "not_found");
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "That operation conflicts with existing data") {
    super(message, 409, "conflict");
    this.name = "ConflictError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "Something went wrong. Please try again.";
}

/** Maps unknown errors to a JSON-safe response, hiding internal details. */
export function toErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  // Redacted logging: never write SQL parameters (financial data) to logs.
  logServerError("unhandled_application_error", error);
  return { status: 500, body: { error: "Something went wrong. Please try again.", code: "internal_error" } };
}
