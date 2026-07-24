import type { AccountResponse } from "@barestash/shared/auth";
import type { Hono } from "hono";

import { getCurrentAccount } from "../../application/current-account.js";
import type { ApiEnv, AppDeps } from "../../container.js";
import {
  getAuthDomainRepository,
  getCredentialPepper,
} from "../../container.js";
import { getAuthorizationHeader } from "../request.js";
import { respondUseCaseError } from "../response.js";
import { setNoStoreHeaders } from "./tokens.js";

/** @public */
export function registerAccountRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.get("/v1/account", async (context) => {
    const result = await getCurrentAccount({
      repository: getAuthDomainRepository(context, deps),
      authorizationHeader: getAuthorizationHeader(context.req.raw),
      credentialPepper: getCredentialPepper(context),
      now: deps.getNow(),
    });

    setNoStoreHeaders(context);

    if (result.kind === "error") return respondUseCaseError(context, result);
    return context.json(result.value satisfies AccountResponse);
  });
}
