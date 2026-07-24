import type { AccountResponse } from "@barestash/shared/auth";

import type { AuthDomainRepository } from "../domain/auth-domain.js";
import {
  authenticateBearerPrincipal,
  type CredentialPepperDeps,
} from "./auth.js";
import { err, ok, type UseCaseResult } from "./result.js";

export type GetCurrentAccountDeps = CredentialPepperDeps & {
  repository: AuthDomainRepository;
  authorizationHeader: string | null;
  now: Date;
};

/** @public */
export async function getCurrentAccount(
  deps: GetCurrentAccountDeps,
): Promise<UseCaseResult<AccountResponse>> {
  const principal = await authenticateBearerPrincipal(
    deps.authorizationHeader,
    deps.repository,
    deps.now,
    { pepper: deps.credentialPepper ?? "" },
  );

  if (principal.kind === "error") return principal;

  const account = await deps.repository.findAccountById(
    principal.value.accountId,
  );

  if (account === null) {
    return err("invalid_token", "The bearer token is invalid.", 401);
  }

  const credential = principal.value.credential;
  return ok({
    account: {
      id: account.id,
      primary_email: account.primary_email,
    },
    credential:
      credential.type === "cli_access_token"
        ? {
            type: credential.type,
            id: credential.id,
            session_id: credential.sessionId,
            scopes: credential.scopes,
            expires_at: credential.expiresAt,
          }
        : {
            type: credential.type,
            id: credential.id,
            scopes: credential.scopes,
            expires_at: credential.expiresAt,
          },
  });
}
