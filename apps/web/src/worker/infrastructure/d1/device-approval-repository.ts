import type { AuthorizationScope } from "@barestash/shared/auth";
import type { AccountId, DeviceAuthorizationId } from "@barestash/shared/ids";

import type {
  BrowserDeviceAccount,
  BrowserDeviceAuthorization,
  DeviceApprovalRepository,
} from "../../application/device-approval.js";

type DeviceRow = Omit<BrowserDeviceAuthorization, "requested_scopes"> & {
  requested_scopes_json: string;
};

/** @public */
export class D1DeviceApprovalRepository implements DeviceApprovalRepository {
  constructor(private readonly db: D1Database) {}

  async findDeviceAuthorizationByUserCodeHash(userCodeHash: string) {
    return this.findDevice(
      "SELECT id, client_name, client_version, device_name, status, requested_scopes_json, expires_at FROM device_authorizations WHERE user_code_hash = ?",
      userCodeHash,
    );
  }

  async findDeviceAuthorizationById(id: DeviceAuthorizationId) {
    return this.findDevice(
      "SELECT id, client_name, client_version, device_name, status, requested_scopes_json, expires_at FROM device_authorizations WHERE id = ?",
      id,
    );
  }

  async findBrowserAccount(
    betterAuthUserId: string,
  ): Promise<BrowserDeviceAccount | null> {
    return (
      (await this.db
        .prepare(`SELECT accounts.id, accounts.primary_email,
            accounts.display_name, accounts.status
          FROM better_auth_account_mappings
          JOIN accounts ON accounts.id = better_auth_account_mappings.account_id
          WHERE better_auth_account_mappings.better_auth_user_id = ?`)
        .bind(betterAuthUserId)
        .first<BrowserDeviceAccount>()) ?? null
    );
  }

  async approveDeviceAuthorization(
    id: DeviceAuthorizationId,
    accountId: AccountId,
    approvedAt: string,
  ) {
    const row =
      (await this.db
        .prepare(`UPDATE device_authorizations
        SET status = 'approved', account_id = ?, approved_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = ? AND accounts.status = 'active'
          )
        RETURNING id, client_name, client_version, device_name, status,
          requested_scopes_json, expires_at`)
        .bind(accountId, approvedAt, id, approvedAt, accountId)
        .first<DeviceRow>()) ?? null;
    return mapDeviceRow(row);
  }

  async denyDeviceAuthorization(id: DeviceAuthorizationId, deniedAt: string) {
    const row =
      (await this.db
        .prepare(`UPDATE device_authorizations
        SET status = 'denied', denied_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?
        RETURNING id, client_name, client_version, device_name, status,
          requested_scopes_json, expires_at`)
        .bind(deniedAt, id, deniedAt)
        .first<DeviceRow>()) ?? null;
    return mapDeviceRow(row);
  }

  private async findDevice(query: string, value: string) {
    const row =
      (await this.db.prepare(query).bind(value).first<DeviceRow>()) ?? null;
    return mapDeviceRow(row);
  }
}

function mapDeviceRow(
  row: DeviceRow | null,
): BrowserDeviceAuthorization | null {
  if (row === null) return null;
  const { requested_scopes_json: scopes, ...authorization } = row;
  return {
    ...authorization,
    requested_scopes: JSON.parse(scopes) as AuthorizationScope[],
  };
}
