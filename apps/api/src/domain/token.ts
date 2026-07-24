import {
  formatPatBearerTokenString,
  generateBearerTokenSecret,
} from "@barestash/shared/bearer-tokens";
import type { TokenId } from "@barestash/shared/ids";

import type { AccountId } from "./endpoint.js";

/** @public */
export type AuthenticatedAccount = {
  accountId: AccountId;
  tokenId: string;
};

/** @public */
export function generateTokenSecret(tokenId: TokenId): string {
  return formatPatBearerTokenString(tokenId, generateBearerTokenSecret());
}
