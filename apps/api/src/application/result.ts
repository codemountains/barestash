import type { RestErrorCode } from "@barestash/shared/errors";

export type HttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 413
  | 429
  | 500
  | 503;

/** @public */
export type UseCaseError = {
  kind: "error";
  code: RestErrorCode;
  message: string;
  status: HttpStatus;
};

/** @public */
export type UseCaseResult<T> = { kind: "ok"; value: T } | UseCaseError;

export function ok<T>(value: T): UseCaseResult<T> {
  return { kind: "ok", value };
}

export function err(
  code: RestErrorCode,
  message: string,
  status: HttpStatus,
): UseCaseError {
  return { kind: "error", code, message, status };
}

export function isError<T>(result: UseCaseResult<T>): result is UseCaseError {
  return result.kind === "error";
}
