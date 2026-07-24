import {
  type BrowserAccountProvisioningRepository,
  type BrowserIdentityProfile,
  type ProvisionedBrowserAccount,
  provisionBrowserAccount,
} from "./provision-account.js";

export type BrowserSessionProfileRepository = {
  findProfileByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<BrowserIdentityProfile | null>;
};

type ProvisionBrowserSessionInput = {
  betterAuthUserId: string;
  profileRepository: BrowserSessionProfileRepository;
  accountRepository: BrowserAccountProvisioningRepository;
  provision?: typeof provisionBrowserAccount;
};

/** @public */
export async function provisionBrowserSession(
  input: ProvisionBrowserSessionInput,
): Promise<ProvisionedBrowserAccount | null> {
  const profile = await input.profileRepository.findProfileByBetterAuthUserId(
    input.betterAuthUserId,
  );

  if (profile === null) return null;

  return (input.provision ?? provisionBrowserAccount)({
    repository: input.accountRepository,
    profile,
  });
}
