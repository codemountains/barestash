/** @public */
export type AuthAuditRecord =
  | {
      event: "barestash.auth.account.created";
      account_id: string;
      provider: "github" | "google";
    }
  | {
      event: "barestash.auth.identity.created";
      account_id: string;
      identity_id: string;
      provider: "github" | "google";
    }
  | {
      event: "barestash.auth.device_authorization.created";
      device_authorization_id: string;
    }
  | {
      event:
        | "barestash.auth.device_authorization.approved"
        | "barestash.auth.device_authorization.denied";
      account_id: string;
      device_authorization_id: string;
    }
  | {
      event: "barestash.auth.cli_session.created";
      account_id: string;
      session_id: string;
      device_authorization_id: string;
    }
  | {
      event:
        | "barestash.auth.cli_session.revoked"
        | "barestash.auth.cli_session.compromised";
      account_id: string;
      session_id: string;
    }
  | {
      event: "barestash.auth.access_token.refreshed";
      account_id: string;
      session_id: string;
      access_token_id: string;
      refresh_token_id: string;
    }
  | {
      event: "barestash.auth.refresh_token.reuse_detected";
      account_id: string;
      session_id: string;
      refresh_token_id: string;
    }
  | {
      event:
        | "barestash.auth.personal_access_token.created"
        | "barestash.auth.personal_access_token.revoked";
      account_id: string;
      token_id: string;
    };

/** @public */
export function formatAuthAuditRecord(record: AuthAuditRecord): string {
  switch (record.event) {
    case "barestash.auth.account.created":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        provider: record.provider,
      });
    case "barestash.auth.identity.created":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        identity_id: record.identity_id,
        provider: record.provider,
      });
    case "barestash.auth.device_authorization.created":
      return JSON.stringify({
        event: record.event,
        device_authorization_id: record.device_authorization_id,
      });
    case "barestash.auth.device_authorization.approved":
    case "barestash.auth.device_authorization.denied":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        device_authorization_id: record.device_authorization_id,
      });
    case "barestash.auth.cli_session.created":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        session_id: record.session_id,
        device_authorization_id: record.device_authorization_id,
      });
    case "barestash.auth.cli_session.revoked":
    case "barestash.auth.cli_session.compromised":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        session_id: record.session_id,
      });
    case "barestash.auth.access_token.refreshed":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        session_id: record.session_id,
        access_token_id: record.access_token_id,
        refresh_token_id: record.refresh_token_id,
      });
    case "barestash.auth.refresh_token.reuse_detected":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        session_id: record.session_id,
        refresh_token_id: record.refresh_token_id,
      });
    case "barestash.auth.personal_access_token.created":
    case "barestash.auth.personal_access_token.revoked":
      return JSON.stringify({
        event: record.event,
        account_id: record.account_id,
        token_id: record.token_id,
      });
  }
}
