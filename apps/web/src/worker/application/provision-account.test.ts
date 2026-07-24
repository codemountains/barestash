import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BrowserAccount,
  type BrowserAccountMapping,
  type BrowserAccountProvisioningRepository,
  type BrowserIdentity,
  type BrowserIdentityProfile,
  type InitialBrowserAccountRecords,
  provisionBrowserAccount,
} from "./provision-account.js";

const now = new Date("2026-07-13T12:00:00.000Z");

function profile(
  overrides: Partial<BrowserIdentityProfile> = {},
): BrowserIdentityProfile {
  return {
    betterAuthUserId: "better-auth-user-1",
    provider: "github",
    providerSubject: "github-user-1",
    email: "user@example.com",
    emailVerified: true,
    displayName: "Example User",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    ...overrides,
  };
}

class InMemoryProvisioningRepository
  implements BrowserAccountProvisioningRepository
{
  readonly accounts = new Map<string, BrowserAccount>();
  readonly identities = new Map<string, BrowserIdentity>();
  readonly mappings = new Map<string, BrowserAccountMapping>();

  async findAccountById(
    id: BrowserAccount["id"],
  ): Promise<BrowserAccount | null> {
    return this.accounts.get(id) ?? null;
  }

  async findIdentityByProvider(
    provider: "github" | "google",
    providerSubject: string,
  ): Promise<BrowserIdentity | null> {
    return this.identities.get(`${provider}:${providerSubject}`) ?? null;
  }

  async findBrowserAccountMappingByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<BrowserAccountMapping | null> {
    return this.mappings.get(betterAuthUserId) ?? null;
  }

  async createInitial(records: InitialBrowserAccountRecords): Promise<void> {
    this.accounts.set(records.account.id, records.account);
    this.identities.set(
      `${records.identity.provider}:${records.identity.provider_subject}`,
      records.identity,
    );
    this.mappings.set(
      records.browserAccountMapping.better_auth_user_id,
      records.browserAccountMapping,
    );
  }

  async createIdentity(record: BrowserIdentity): Promise<void> {
    this.identities.set(
      `${record.provider}:${record.provider_subject}`,
      record,
    );
  }

  async createBrowserAccountMapping(
    record: BrowserAccountMapping,
  ): Promise<void> {
    this.mappings.set(record.better_auth_user_id, record);
  }

  async rebindBrowserAccountMapping(
    record: BrowserAccountMapping,
  ): Promise<void> {
    for (const [betterAuthUserId, mapping] of this.mappings) {
      if (mapping.account_id === record.account_id) {
        this.mappings.delete(betterAuthUserId);
      }
    }
    this.mappings.set(record.better_auth_user_id, record);
  }
}

const ids = {
  account: () => "acc_new" as const,
  identity: () => "idn_new" as const,
  browserAccountMapping: () => "bam_new" as const,
};

describe("provisionBrowserAccount", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates and subsequently resolves one Barestash account from a GitHub subject", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repository = new InMemoryProvisioningRepository();

    const first = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids,
    });
    const second = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids,
    });

    expect(first.accountId).toBe("acc_new");
    expect(second).toEqual(first);
    expect(repository.accounts).toHaveLength(1);
    expect(repository.identities).toHaveLength(1);
    expect(repository.mappings).toHaveLength(1);
    expect(repository.identities.get("github:github-user-1")).toMatchObject({
      account_id: "acc_new",
      email: "user@example.com",
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.account.created",
        account_id: "acc_new",
        provider: "github",
      }),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "barestash.auth.identity.created",
        account_id: "acc_new",
        identity_id: "idn_new",
        provider: "github",
      }),
    );
    expect(log.mock.calls.join("\n")).not.toContain("user@example.com");
  });

  it("repairs an incomplete prior attempt when the provider identity exists without a browser mapping", async () => {
    const repository = new InMemoryProvisioningRepository();
    repository.accounts.set("acc_existing", {
      id: "acc_existing",
      primary_email: "user@example.com",
      display_name: "Existing User",
      avatar_url: null,
      status: "active",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    repository.identities.set("github:github-user-1", {
      id: "idn_existing",
      account_id: "acc_existing",
      provider: "github",
      provider_subject: "github-user-1",
      email: "user@example.com",
      email_verified: true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    const result = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids,
    });

    expect(result.accountId).toBe("acc_existing");
    expect(repository.mappings.get("better-auth-user-1")).toMatchObject({
      account_id: "acc_existing",
    });
  });

  it("rebinds a stale browser mapping when the provider identity belongs to the same account", async () => {
    class UniqueAccountMappingRepository extends InMemoryProvisioningRepository {
      override async createBrowserAccountMapping(
        record: BrowserAccountMapping,
      ): Promise<void> {
        if (
          [...this.mappings.values()].some(
            (mapping) => mapping.account_id === record.account_id,
          )
        ) {
          throw new Error(
            "UNIQUE constraint failed: better_auth_account_mappings.account_id",
          );
        }

        await super.createBrowserAccountMapping(record);
      }
    }

    const repository = new UniqueAccountMappingRepository();
    repository.accounts.set("acc_existing", {
      id: "acc_existing",
      primary_email: "user@example.com",
      display_name: "Existing User",
      avatar_url: null,
      status: "active",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    repository.identities.set("github:github-user-1", {
      id: "idn_existing",
      account_id: "acc_existing",
      provider: "github",
      provider_subject: "github-user-1",
      email: "user@example.com",
      email_verified: true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    repository.mappings.set("stale-better-auth-user", {
      id: "bam_stale",
      better_auth_user_id: "stale-better-auth-user",
      account_id: "acc_existing",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    await expect(
      provisionBrowserAccount({ repository, profile: profile(), now, ids }),
    ).resolves.toEqual({ accountId: "acc_existing" });

    expect(repository.mappings.has("stale-better-auth-user")).toBe(false);
    expect(repository.mappings.get("better-auth-user-1")).toMatchObject({
      account_id: "acc_existing",
    });
  });

  it("repairs an incomplete prior attempt when the browser mapping exists without an identity", async () => {
    const repository = new InMemoryProvisioningRepository();
    repository.accounts.set("acc_existing", {
      id: "acc_existing",
      primary_email: "user@example.com",
      display_name: "Existing User",
      avatar_url: null,
      status: "active",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    repository.mappings.set("better-auth-user-1", {
      id: "bam_existing",
      better_auth_user_id: "better-auth-user-1",
      account_id: "acc_existing",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    const result = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids,
    });

    expect(result.accountId).toBe("acc_existing");
    expect(repository.identities.get("github:github-user-1")).toMatchObject({
      account_id: "acc_existing",
    });
  });

  it("retries a concurrent identity repair without creating another account", async () => {
    class ConcurrentRepairRepository extends InMemoryProvisioningRepository {
      private shouldConflict = true;

      override async createIdentity(record: BrowserIdentity): Promise<void> {
        if (this.shouldConflict) {
          this.shouldConflict = false;
          this.identities.set(
            `${record.provider}:${record.provider_subject}`,
            record,
          );
          throw new Error(
            "UNIQUE constraint failed: identities.provider, identities.provider_subject",
          );
        }

        await super.createIdentity(record);
      }
    }

    const repository = new ConcurrentRepairRepository();
    repository.accounts.set("acc_existing", {
      id: "acc_existing",
      primary_email: "user@example.com",
      display_name: "Existing User",
      avatar_url: null,
      status: "active",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    repository.mappings.set("better-auth-user-1", {
      id: "bam_existing",
      better_auth_user_id: "better-auth-user-1",
      account_id: "acc_existing",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    await expect(
      provisionBrowserAccount({ repository, profile: profile(), now, ids }),
    ).resolves.toEqual({ accountId: "acc_existing" });

    expect(repository.accounts).toHaveLength(1);
    expect(repository.identities).toHaveLength(1);
    expect(repository.mappings).toHaveLength(1);
  });

  it("does not implicitly link different GitHub identities that share an email address", async () => {
    const repository = new InMemoryProvisioningRepository();

    const first = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids: {
        account: () => "acc_first" as const,
        identity: () => "idn_first" as const,
        browserAccountMapping: () => "bam_first" as const,
      },
    });
    const second = await provisionBrowserAccount({
      repository,
      profile: profile({
        betterAuthUserId: "better-auth-user-2",
        providerSubject: "github-user-2",
      }),
      now,
      ids: {
        account: () => "acc_second" as const,
        identity: () => "idn_second" as const,
        browserAccountMapping: () => "bam_second" as const,
      },
    });

    expect(first.accountId).toBe("acc_first");
    expect(second.accountId).toBe("acc_second");
    expect(repository.accounts).toHaveLength(2);
  });

  it("does not implicitly link GitHub and Google identities that share an email address", async () => {
    const repository = new InMemoryProvisioningRepository();

    const github = await provisionBrowserAccount({
      repository,
      profile: profile(),
      now,
      ids: {
        account: () => "acc_github" as const,
        identity: () => "idn_github" as const,
        browserAccountMapping: () => "bam_github" as const,
      },
    });
    const google = await provisionBrowserAccount({
      repository,
      profile: profile({
        betterAuthUserId: "better-auth-google-user",
        provider: "google",
        providerSubject: "google-subject-1",
      }),
      now,
      ids: {
        account: () => "acc_google" as const,
        identity: () => "idn_google" as const,
        browserAccountMapping: () => "bam_google" as const,
      },
    });

    expect(github.accountId).toBe("acc_github");
    expect(google.accountId).toBe("acc_google");
    expect(repository.accounts).toHaveLength(2);
    expect(repository.identities).toHaveLength(2);
  });
});
