import { describe, expect, it, vi } from "vitest";

import type {
  BrowserAccountProvisioningRepository,
  BrowserIdentityProfile,
} from "./provision-account.js";
import { provisionBrowserSession } from "./provision-browser-session.js";

const profile: BrowserIdentityProfile = {
  betterAuthUserId: "better-auth-user",
  provider: "github",
  providerSubject: "123456",
  email: "user@example.com",
  emailVerified: true,
  displayName: "Example User",
  avatarUrl: null,
};

describe("provisionBrowserSession", () => {
  it("provisions the Barestash account from the provider account attached to a browser session", async () => {
    const findProfileByBetterAuthUserId = vi.fn().mockResolvedValue(profile);
    const provision = vi.fn().mockResolvedValue({ accountId: "acc_example" });

    await expect(
      provisionBrowserSession({
        betterAuthUserId: "better-auth-user",
        profileRepository: { findProfileByBetterAuthUserId },
        accountRepository: {} as BrowserAccountProvisioningRepository,
        provision,
      }),
    ).resolves.toEqual({ accountId: "acc_example" });

    expect(findProfileByBetterAuthUserId).toHaveBeenCalledWith(
      "better-auth-user",
    );
    expect(provision).toHaveBeenCalledWith({
      repository: expect.anything(),
      profile,
    });
  });

  it("does not create a domain identity when the session has no supported provider account", async () => {
    const provision = vi.fn();

    await expect(
      provisionBrowserSession({
        betterAuthUserId: "better-auth-user",
        profileRepository: {
          findProfileByBetterAuthUserId: vi.fn().mockResolvedValue(null),
        },
        accountRepository: {} as BrowserAccountProvisioningRepository,
        provision,
      }),
    ).resolves.toBeNull();

    expect(provision).not.toHaveBeenCalled();
  });
});
