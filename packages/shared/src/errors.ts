/** @public */
export type RestErrorCode =
  | "authorization_pending"
  | "authorization_denied"
  | "device_code_expired"
  | "device_code_consumed"
  | "device_authorization_unavailable"
  | "invalid_device_code"
  | "invalid_user_code"
  | "slow_down"
  | "invalid_request"
  | "endpoint_not_found"
  | "endpoint_expired"
  | "not_authenticated"
  | "not_authorized"
  | "invalid_token"
  | "access_token_expired"
  | "token_revoked"
  | "personal_access_token_expired"
  | "insufficient_scope"
  | "refresh_token_expired"
  | "refresh_token_revoked"
  | "refresh_token_reuse_detected"
  | "session_expired"
  | "session_revoked"
  | "account_disabled"
  | "idempotency_key_required"
  | "idempotency_key_conflict"
  | "missing_ingest_secret"
  | "invalid_ingest_secret"
  | "temporary_endpoint_delete_not_supported"
  | "payload_too_large"
  | "event_limit_exceeded"
  | "rate_limit_exceeded"
  | "rate_limit_unavailable"
  | "event_not_found"
  | "body_not_found"
  | "r2_write_failed"
  | "d1_write_failed"
  | "internal_error";

/** @public */
export type RestErrorResponse = {
  error: {
    code: RestErrorCode;
    message: string;
  };
};

/** @public */
export function createRestErrorResponse(
  code: RestErrorCode,
  message: string,
): RestErrorResponse {
  return {
    error: {
      code,
      message,
    },
  };
}
