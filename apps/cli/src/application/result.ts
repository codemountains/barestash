import type { RestErrorResponse } from "@barestash/shared/errors";

export type CliApiError = {
  kind: "api-error";
  error: RestErrorResponse;
};

/** @public */
export class CliApiErrorException extends Error {
  readonly error: RestErrorResponse;

  constructor(error: RestErrorResponse) {
    super(error.error.message);
    this.name = "CliApiErrorException";
    this.error = error;
  }
}

export type CliLocalError = {
  kind: "local-error";
  message: string;
};

/** @public */
export type CliResult<T> =
  | { kind: "ok"; value: T }
  | CliApiError
  | CliLocalError;

export function ok<T>(value: T): CliResult<T> {
  return { kind: "ok", value };
}

export function apiError(error: RestErrorResponse): CliApiError {
  return { kind: "api-error", error };
}

export function localError(message: string): CliLocalError {
  return { kind: "local-error", message };
}

export function fromApiCall<T>(
  result:
    | { kind: "ok"; value: T }
    | { kind: "error"; error: RestErrorResponse },
): CliResult<T> {
  if (result.kind === "error") {
    return apiError(result.error);
  }

  return ok(result.value);
}
