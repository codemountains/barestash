import type { AuthorizationScope } from "@barestash/shared/auth";
import type { AccountId, DeviceAuthorizationId } from "@barestash/shared/ids";

/** @public */
export type BrowserDeviceAccount = {
  id: AccountId;
  primary_email: string | null;
  display_name: string | null;
  status: "active" | "disabled";
};

/** @public */
export type BrowserDeviceAuthorization = {
  id: DeviceAuthorizationId;
  client_name: string;
  client_version: string | null;
  device_name: string | null;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  requested_scopes: AuthorizationScope[];
  expires_at: string;
};

/** @public */
export type DeviceApprovalRepository = {
  findDeviceAuthorizationByUserCodeHash(
    userCodeHash: string,
  ): Promise<BrowserDeviceAuthorization | null>;
  findDeviceAuthorizationById(
    id: DeviceAuthorizationId,
  ): Promise<BrowserDeviceAuthorization | null>;
  findBrowserAccount(
    betterAuthUserId: string,
  ): Promise<BrowserDeviceAccount | null>;
  approveDeviceAuthorization(
    id: DeviceAuthorizationId,
    accountId: AccountId,
    approvedAt: string,
  ): Promise<BrowserDeviceAuthorization | null>;
  denyDeviceAuthorization(
    id: DeviceAuthorizationId,
    deniedAt: string,
  ): Promise<BrowserDeviceAuthorization | null>;
};

/** @public */
export function normalizeUserCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[-\s]/g, "");
  return /^[A-HJ-KM-NP-Z]{8}$/.test(normalized) ? normalized : null;
}

/** @public */
export function displayUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** @public */
export async function hashDeviceUserCode(
  normalizedCode: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hash = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(normalizedCode),
    ),
  );
  return `hmac-sha256$${Array.from(hash)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
