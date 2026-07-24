import { describe, expect, it } from "vitest";
import { makeIo } from "../../testing/helpers.js";
import { printTokenCreated, printTokenList } from "./tokens.js";

describe("token output", () => {
  it("prints newly created token secrets exactly once", () => {
    const { io, stdout } = makeIo();

    printTokenCreated(io, {
      id: "tok_created",
      name: "CI",
      token: "bst_visible_once",
      status: "active",
      scopes: ["events:read"],
      created_at: "2026-07-05T12:00:00.000Z",
      expires_at: "2026-10-03T12:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    });

    expect(stdout).toEqual([
      "Created token: tok_created",
      "",
      "Token (shown once):",
      "bst_visible_once",
      "",
      "Save this token now. It will not be shown again.",
      "",
      "Use it with:",
      "  export BARESTASH_TOKEN=...",
      '  echo "$BARESTASH_TOKEN" | barestash auth login --with-token',
    ]);
  });

  it("prints token lists without raw token secrets", () => {
    const { io, stdout } = makeIo();

    printTokenList(io, [
      {
        id: "tok_listed",
        name: null,
        status: "revoked",
        scopes: ["events:read"],
        created_at: "2026-07-05T12:00:00.000Z",
        expires_at: null,
        last_used_at: null,
        revoked_at: "2026-07-06T12:00:00.000Z",
      },
    ]);

    expect(stdout).toEqual([
      "ID          NAME         SCOPES                       EXPIRES                  LAST_USED             STATUS",
      "tok_listed  -  events:read  never  never  revoked",
    ]);
    expect(stdout.join("\n")).not.toContain("bst_");
  });
});
