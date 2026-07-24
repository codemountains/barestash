import type {
  PersonalAccessTokenCreateResponse,
  PersonalAccessTokenMetadata,
} from "@barestash/shared/personal-access-tokens";

import type { CliIo } from "../../domain/ports.js";

/** @public */
export function printTokenCreated(
  io: CliIo,
  result: PersonalAccessTokenCreateResponse,
): void {
  io.stdout(`Created token: ${result.id}`);
  io.stdout("");
  io.stdout("Token (shown once):");
  io.stdout(result.token);
  io.stdout("");
  io.stdout("Save this token now. It will not be shown again.");
  io.stdout("");
  io.stdout("Use it with:");
  io.stdout("  export BARESTASH_TOKEN=...");
  io.stdout('  echo "$BARESTASH_TOKEN" | barestash auth login --with-token');
}

/** @public */
export function printTokenList(
  io: CliIo,
  tokens: PersonalAccessTokenMetadata[],
): void {
  io.stdout(
    "ID          NAME         SCOPES                       EXPIRES                  LAST_USED             STATUS",
  );

  for (const token of tokens) {
    io.stdout(
      `${token.id}  ${token.name ?? "-"}  ${token.scopes.join(",")}  ${token.expires_at ?? "never"}  ${token.last_used_at ?? "never"}  ${token.status}`,
    );
  }
}
