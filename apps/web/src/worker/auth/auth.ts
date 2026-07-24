import { betterAuth } from "better-auth";

import { provisionBrowserSession } from "../application/provision-browser-session.js";
import { D1BrowserAccountProvisioningRepository } from "../infrastructure/d1/account-provisioning-repository.js";
import { D1BetterAuthProfileRepository } from "../infrastructure/d1/better-auth-profile-repository.js";
import {
  type BrowserAuthEnvironment,
  createBrowserAuthOptions,
} from "./browser-auth-options.js";
import { createD1CompensatingAdapter } from "./d1-compensating-adapter.js";

/** @public */
export type WebEnvironment = BrowserAuthEnvironment;

/** @public */
export async function createBrowserAuth(environment: WebEnvironment) {
  const accountRepository = new D1BrowserAccountProvisioningRepository(
    environment.DB,
  );
  const profileRepository = new D1BetterAuthProfileRepository(environment.DB);

  const options = createBrowserAuthOptions(environment, {
    provisionForSession: async (betterAuthUserId) => {
      await provisionBrowserSession({
        betterAuthUserId,
        accountRepository,
        profileRepository,
      });
    },
  });
  const adapter = await createD1CompensatingAdapter(options, environment.DB);

  return betterAuth({
    ...options,
    database: () => adapter,
  });
}
