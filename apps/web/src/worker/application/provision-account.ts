import {
  type AccountId,
  type BrowserAccountMappingId,
  generateAccountId,
  generateBrowserAccountMappingId,
  generateIdentityId,
  type IdentityId,
} from "@barestash/shared/ids";
import { logAuthAudit } from "./auth-audit.js";

/** @public */
export type BrowserIdentityProfile = {
  betterAuthUserId: string;
  provider: "github" | "google";
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

/** @public */
export type BrowserAccount = {
  id: AccountId;
  primary_email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

/** @public */
export type BrowserIdentity = {
  id: IdentityId;
  account_id: AccountId;
  provider: "github" | "google";
  provider_subject: string;
  email: string | null;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
};

/** @public */
export type BrowserAccountMapping = {
  id: BrowserAccountMappingId;
  better_auth_user_id: string;
  account_id: AccountId;
  created_at: string;
  updated_at: string;
};

/** @public */
export type InitialBrowserAccountRecords = {
  account: BrowserAccount;
  identity: BrowserIdentity;
  browserAccountMapping: BrowserAccountMapping;
};

/** @public */
export type BrowserAccountProvisioningRepository = {
  findAccountById(id: AccountId): Promise<BrowserAccount | null>;
  findIdentityByProvider(
    provider: BrowserIdentityProfile["provider"],
    providerSubject: string,
  ): Promise<BrowserIdentity | null>;
  findBrowserAccountMappingByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<BrowserAccountMapping | null>;
  createInitial(records: InitialBrowserAccountRecords): Promise<void>;
  createIdentity(record: BrowserIdentity): Promise<void>;
  createBrowserAccountMapping(record: BrowserAccountMapping): Promise<void>;
  rebindBrowserAccountMapping(record: BrowserAccountMapping): Promise<void>;
};

type ProvisioningIds = {
  account: () => AccountId;
  identity: () => IdentityId;
  browserAccountMapping: () => BrowserAccountMappingId;
};

type ProvisionBrowserAccountInput = {
  repository: BrowserAccountProvisioningRepository;
  profile: BrowserIdentityProfile;
  now?: Date;
  ids?: ProvisioningIds;
};

export type ProvisionedBrowserAccount = { accountId: AccountId };

export class BrowserAccountProvisioningConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAccountProvisioningConflictError";
  }
}

export async function provisionBrowserAccount(
  input: ProvisionBrowserAccountInput,
): Promise<ProvisionedBrowserAccount> {
  return provision(input, false);
}

async function provision(
  input: ProvisionBrowserAccountInput,
  retriedAfterConflict: boolean,
): Promise<ProvisionedBrowserAccount> {
  try {
    const { profile, repository } = input;
    const [mapping, identity] = await Promise.all([
      repository.findBrowserAccountMappingByBetterAuthUserId(
        profile.betterAuthUserId,
      ),
      repository.findIdentityByProvider(
        profile.provider,
        profile.providerSubject,
      ),
    ]);

    if (mapping !== null && identity !== null) {
      if (mapping.account_id !== identity.account_id) {
        throw new BrowserAccountProvisioningConflictError(
          "The browser account mapping and provider identity resolve different accounts.",
        );
      }

      await requireAccount(repository, mapping.account_id);
      return { accountId: mapping.account_id };
    }

    if (mapping !== null) {
      await requireAccount(repository, mapping.account_id);
      const identity = identityRecord({
        profile,
        accountId: mapping.account_id,
        now: timestamp(input.now),
        ids: input.ids ?? defaultIds,
      });
      await repository.createIdentity(identity);
      logAuthAudit({
        event: "barestash.auth.identity.created",
        account_id: mapping.account_id,
        identity_id: identity.id,
        provider: profile.provider,
      });
      return { accountId: mapping.account_id };
    }

    if (identity !== null) {
      await requireAccount(repository, identity.account_id);
      await repository.rebindBrowserAccountMapping(
        mappingRecord({
          betterAuthUserId: profile.betterAuthUserId,
          accountId: identity.account_id,
          now: timestamp(input.now),
          ids: input.ids ?? defaultIds,
        }),
      );
      return { accountId: identity.account_id };
    }

    const now = timestamp(input.now);
    const ids = input.ids ?? defaultIds;
    const account = accountRecord({ profile, now, ids });

    const newIdentity = identityRecord({
      profile,
      accountId: account.id,
      now,
      ids,
    });
    await repository.createInitial({
      account,
      identity: newIdentity,
      browserAccountMapping: mappingRecord({
        betterAuthUserId: profile.betterAuthUserId,
        accountId: account.id,
        now,
        ids,
      }),
    });
    logAuthAudit({
      event: "barestash.auth.account.created",
      account_id: account.id,
      provider: profile.provider,
    });
    logAuthAudit({
      event: "barestash.auth.identity.created",
      account_id: account.id,
      identity_id: newIdentity.id,
      provider: profile.provider,
    });
    return { accountId: account.id };
  } catch (error) {
    if (!retriedAfterConflict && isUniqueConstraintError(error)) {
      return provision(input, true);
    }
    throw error;
  }
}

const defaultIds: ProvisioningIds = {
  account: generateAccountId,
  identity: generateIdentityId,
  browserAccountMapping: generateBrowserAccountMappingId,
};

function accountRecord({
  profile,
  now,
  ids,
}: {
  profile: BrowserIdentityProfile;
  now: string;
  ids: ProvisioningIds;
}): BrowserAccount {
  return {
    id: ids.account(),
    primary_email: profile.email,
    display_name: profile.displayName,
    avatar_url: profile.avatarUrl,
    status: "active",
    created_at: now,
    updated_at: now,
  };
}

function identityRecord({
  profile,
  accountId,
  now,
  ids,
}: {
  profile: BrowserIdentityProfile;
  accountId: AccountId;
  now: string;
  ids: ProvisioningIds;
}): BrowserIdentity {
  return {
    id: ids.identity(),
    account_id: accountId,
    provider: profile.provider,
    provider_subject: profile.providerSubject,
    email: profile.email,
    email_verified: profile.emailVerified,
    created_at: now,
    updated_at: now,
  };
}

function mappingRecord({
  betterAuthUserId,
  accountId,
  now,
  ids,
}: {
  betterAuthUserId: string;
  accountId: AccountId;
  now: string;
  ids: ProvisioningIds;
}): BrowserAccountMapping {
  return {
    id: ids.browserAccountMapping(),
    better_auth_user_id: betterAuthUserId,
    account_id: accountId,
    created_at: now,
    updated_at: now,
  };
}

async function requireAccount(
  repository: BrowserAccountProvisioningRepository,
  accountId: AccountId,
): Promise<void> {
  if ((await repository.findAccountById(accountId)) === null) {
    throw new BrowserAccountProvisioningConflictError(
      "The browser account mapping or provider identity references a missing account.",
    );
  }
}

function timestamp(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}
