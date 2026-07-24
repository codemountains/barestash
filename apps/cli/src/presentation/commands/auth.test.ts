import type { AccountResponse } from "@barestash/shared/auth";
import {
  formatBearerTokenString,
  formatPatBearerTokenString,
  generateBearerTokenSecret,
} from "@barestash/shared/bearer-tokens";
import { describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import type { StoredCredential } from "../../domain/credential.js";
import { makeIo, testTokenId } from "../../testing/helpers.js";

const accountResponse: AccountResponse = {
  account: { id: "acc_test", primary_email: "user@example.com" },
  credential: {
    type: "personal_access_token",
    id: "tok_stdin",
    scopes: ["endpoints:read", "events:read"],
    expires_at: "2026-10-03T12:00:00.000Z",
  },
};

describe("auth commands", () => {
  it("completes Device Authorization login and stores a refreshable session", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const stored: unknown[] = [];
    const opened: string[] = [];
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json(
        {
          error: {
            code: "authorization_pending",
            message: "Authorization is still pending.",
          },
        },
        { status: 400 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json({
        account: { id: "acc_test", primary_email: "user@example.com" },
        credential: {
          type: "cli_access_token",
          id: "atk_test",
          session_id: "cls_test",
          scopes: ["events:read"],
          expires_at: "2026-07-14T01:00:00.000Z",
        },
      } satisfies AccountResponse),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async (url) => {
        opened.push(url);
        return true;
      },
      sleep: async () => {},
      readCredential: async () => null,
      writeCredential: async (credential) => {
        stored.push(credential);
        return { storage: "keyring" };
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/auth/device/token",
      "/v1/account",
    ]);
    expect(opened).toEqual(["https://app.example.com/device?code=JKLM-PQRS"]);
    expect(stored).toEqual([
      {
        type: "cli_session",
        session_id: "cls_test",
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        access_token_expires_at: "2026-07-14T01:00:00.000Z",
        refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
        scopes: ["events:read"],
      },
    ]);
    expect(stderr.join("\n")).toContain("https://app.example.com/device");
    expect(stderr.join("\n")).toContain("JKLM-PQRS");
    expect(stdout).toEqual([
      "Authenticated as user@example.com (cls_test)",
      "Session expires: 2026-10-12T00:00:00.000Z",
    ]);
  });

  it("revokes a newly issued CLI session when credential persistence fails", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json({
        account: { id: "acc_test", primary_email: "user@example.com" },
        credential: {
          type: "cli_access_token",
          id: "atk_test",
          session_id: "cls_test",
          scopes: ["events:read"],
          expires_at: "2026-07-14T01:00:00.000Z",
        },
      } satisfies AccountResponse),
      Response.json({ session: { id: "cls_test", status: "revoked" } }),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => null,
      writeCredential: async () => {
        throw new Error("Unable to persist the CLI credential.");
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[3].headers.get("authorization")).toBe(
      "Bearer bst_access_session",
    );
    expect(stderr.join("\n")).toContain(
      "Unable to persist the CLI credential.",
    );
  });

  it("keeps a persisted session when legacy config cleanup fails", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    let stored: StoredCredential | null = {
      type: "personal_access_token",
      token: "previous-pat",
    };
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json({
        account: { id: "acc_test", primary_email: "user@example.com" },
        credential: {
          type: "cli_access_token",
          id: "atk_test",
          session_id: "cls_test",
          scopes: ["events:read"],
          expires_at: "2026-07-14T01:00:00.000Z",
        },
      } satisfies AccountResponse),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => stored,
      writeCredential: async (credential) => {
        stored = credential;
        return { storage: "keyring" };
      },
      readConfig: async () => JSON.stringify({ token: "legacy-pat" }),
      writeConfig: async () => {
        throw new Error("Unable to clear the legacy config token.");
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
    ]);
    expect(stored).toMatchObject({
      type: "cli_session",
      session_id: "cls_test",
      access_token: "bst_access_session",
    });
    expect(stderr.join("\n")).toContain(
      "Unable to remove the legacy authentication token from the config file.",
    );
    expect(stdout).toContain("Authenticated as user@example.com (cls_test)");
  });

  it("revokes a newly issued CLI session when account validation fails", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    const stored: StoredCredential[] = [];
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json(
        {
          error: {
            code: "internal_error",
            message: "Account validation failed.",
          },
        },
        { status: 500 },
      ),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => null,
      writeCredential: async (credential) => {
        stored.push(credential);
        return { storage: "keyring" };
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (
          new URL(request.url).pathname === "/v1/auth/sessions/current/revoke"
        ) {
          throw new Error("Session cleanup connection failed.");
        }
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[3].headers.get("authorization")).toBe(
      "Bearer bst_access_session",
    );
    expect(stored).toEqual([]);
    expect(stderr.join("\n")).toContain("Account validation failed.");
    expect(stderr.join("\n")).toContain(
      "The newly issued remote CLI session may still be active.",
    );
  });

  it("revokes a newly issued session when account metadata has the wrong credential type", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json(accountResponse),
      Response.json({ session: { id: "cls_test", status: "revoked" } }),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => null,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(stderr.join("\n")).toContain(
      "Device Authorization did not issue a CLI session.",
    );
    expect(stderr.join("\n")).not.toContain(
      "The newly issued remote CLI session may still be active.",
    );
  });

  it("revokes a newly issued session when account validation cannot connect", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_session",
        refresh_token: "bst_refresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json({ session: { id: "cls_test", status: "revoked" } }),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => null,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).pathname === "/v1/account") {
          throw new Error("Account validation connection failed.");
        }
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(stderr.join("\n")).toContain(
      "Account validation connection failed.",
    );
  });

  it("does not validate a newly issued token with the stored session after access_token_expired", async () => {
    const { io } = makeIo();
    const requests: Request[] = [];
    const stored: StoredCredential[] = [];
    const existingCredential: StoredCredential = {
      type: "cli_session",
      session_id: "cls_existing",
      access_token: "bst_access_existing",
      refresh_token: "bst_refresh_existing",
      access_token_expires_at: "2026-07-14T01:00:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_issued",
        refresh_token: "bst_refresh_issued",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json(
        {
          error: {
            code: "access_token_expired",
            message: "The issued access token expired.",
          },
        },
        { status: 401 },
      ),
      Response.json({
        account: { id: "acc_test", primary_email: "user@example.com" },
        credential: {
          type: "cli_access_token",
          id: "atk_existing",
          session_id: "cls_existing",
          scopes: ["events:read"],
          expires_at: "2026-07-14T01:00:00.000Z",
        },
      } satisfies AccountResponse),
      Response.json({ session: { id: "cls_issued", status: "revoked" } }),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => existingCredential,
      writeCredential: async (credential) => {
        stored.push(credential);
        return { storage: "keyring" };
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[2].headers.get("authorization")).toBe(
      "Bearer bst_access_issued",
    );
    expect(requests[3].headers.get("authorization")).toBe(
      "Bearer bst_access_issued",
    );
    expect(stored).toEqual([]);
  });

  it("does not retry issued-session cleanup with the stored session token", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    const existingCredential: StoredCredential = {
      type: "cli_session",
      session_id: "cls_existing",
      access_token: "bst_access_existing",
      refresh_token: "bst_refresh_existing",
      access_token_expires_at: "2026-07-14T01:00:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    const responses = [
      Response.json(
        {
          device_code: `bst_device_${"d".repeat(32)}`,
          user_code: "JKLM-PQRS",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete:
            "https://app.example.com/device?code=JKLM-PQRS",
          expires_in: 600,
          interval: 5,
        },
        { status: 201 },
      ),
      Response.json({
        access_token: "bst_access_issued",
        refresh_token: "bst_refresh_issued",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scopes: ["events:read"],
      }),
      Response.json(
        {
          error: {
            code: "internal_error",
            message: "Account validation failed.",
          },
        },
        { status: 500 },
      ),
      Response.json(
        {
          error: {
            code: "access_token_expired",
            message: "The issued access token expired.",
          },
        },
        { status: 401 },
      ),
      Response.json({ session: { id: "cls_existing", status: "revoked" } }),
    ];

    const exitCode = await runCli(["auth", "login"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      deviceName: "test-device",
      openBrowser: async () => true,
      sleep: async () => {},
      readCredential: async () => existingCredential,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected request");
        return response;
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/auth/device/authorizations",
      "/v1/auth/device/token",
      "/v1/account",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[3].headers.get("authorization")).toBe(
      "Bearer bst_access_issued",
    );
    expect(stderr.join("\n")).toContain(
      "The newly issued remote CLI session may still be active.",
    );
  });

  it("warns when --insecure-storage writes plaintext credentials", async () => {
    const { io, stderr } = makeIo();
    const exitCode = await runCli(
      ["auth", "login", "--with-token", "--insecure-storage"],
      io,
      {
        env: { BARESTASH_API_URL: "https://api.example.com" },
        readStdin: async () => "bst_pat_stdin",
        readCredential: async () => null,
        writeCredential: async () => ({
          storage: "plaintext",
          path: "/tmp/barestash/credentials.json",
          fallback: false,
        }),
        fetch: async () => Response.json(accountResponse),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join("\n")).toContain("plaintext");
    expect(stderr.join("\n")).toContain("/tmp/barestash/credentials.json");
  });

  it("serializes concurrent proactive refresh and reloads the rotated credential", async () => {
    const firstIo = makeIo();
    const secondIo = makeIo();
    let credential: Extract<StoredCredential, { type: "cli_session" }> = {
      type: "cli_session" as const,
      session_id: "cls_test",
      access_token: "old-access",
      refresh_token: "old-refresh",
      access_token_expires_at: "2026-07-14T00:04:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read" as const],
    };
    let tail = Promise.resolve();
    const lock = {
      async withLock<T>(operation: () => Promise<T>) {
        const previous = tail;
        let release = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
    };
    const paths: string[] = [];
    const options = {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      credentialLock: lock,
      readCredential: async () => credential,
      replaceCredential: async (next: StoredCredential) => {
        if (next.type === "cli_session") credential = next;
      },
      fetch: async (input: string | URL | Request) => {
        const path = new URL(new Request(input).url).pathname;
        paths.push(path);
        return path === "/v1/auth/token/refresh"
          ? Response.json({
              access_token: "new-access",
              refresh_token: "new-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token_expires_in: 7_776_000,
            })
          : Response.json({
              account: accountResponse.account,
              credential: {
                type: "cli_access_token",
                id: "atk_new",
                session_id: "cls_test",
                scopes: ["events:read"],
                expires_at: "2026-07-14T01:00:00.000Z",
              },
            } satisfies AccountResponse);
      },
    };

    const results = await Promise.all([
      runCli(["auth", "status"], firstIo.io, options),
      runCli(["auth", "status"], secondIo.io, options),
    ]);

    expect(results).toEqual([0, 0]);
    expect(
      paths.filter((path) => path === "/v1/auth/token/refresh"),
    ).toHaveLength(1);
    expect(credential.access_token).toBe("new-access");
  });

  it("refreshes and retries once after access_token_expired", async () => {
    const { io } = makeIo();
    let credential: Extract<StoredCredential, { type: "cli_session" }> = {
      type: "cli_session" as const,
      session_id: "cls_test",
      access_token: "old-access",
      refresh_token: "old-refresh",
      access_token_expires_at: "2026-07-14T00:30:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read" as const],
    };
    const paths: string[] = [];
    let accountCalls = 0;
    const exitCode = await runCli(["auth", "status"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => credential,
      replaceCredential: async (next) => {
        credential = next as typeof credential;
      },
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        paths.push(path);
        if (path === "/v1/auth/token/refresh") {
          return Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
          });
        }
        accountCalls += 1;
        return accountCalls === 1
          ? Response.json(
              {
                error: {
                  code: "access_token_expired",
                  message: "The access token has expired.",
                },
              },
              { status: 401 },
            )
          : Response.json({
              account: accountResponse.account,
              credential: {
                type: "cli_access_token",
                id: "atk_new",
                session_id: "cls_test",
                scopes: ["events:read"],
                expires_at: "2026-07-14T01:00:00.000Z",
              },
            } satisfies AccountResponse);
      },
    });

    expect(exitCode).toBe(0);
    expect(paths).toEqual([
      "/v1/account",
      "/v1/auth/token/refresh",
      "/v1/account",
    ]);
  });

  it("clears stale credentials when rotated credential persistence fails", async () => {
    const { io, stderr } = makeIo();
    let deleted = false;
    const exitCode = await runCli(["auth", "status"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "old-access",
        refresh_token: "old-refresh",
        access_token_expires_at: "2026-07-14T00:04:00.000Z",
        refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
        scopes: ["events:read"],
      }),
      replaceCredential: async () => {
        throw new Error("Unable to persist rotated credentials.");
      },
      deleteCredential: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token_expires_in: 7_776_000,
        }),
    });

    expect(exitCode).toBe(1);
    expect(deleted).toBe(true);
    expect(stderr.join("\n")).toContain(
      "Unable to persist rotated credentials.",
    );
  });

  it("reports refresh authentication failures without a connectivity wrapper", async () => {
    const { io, stderr } = makeIo();
    let deleted = false;
    const exitCode = await runCli(["auth", "status"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "expired-access",
        refresh_token: "expired-refresh",
        access_token_expires_at: "2026-07-14T00:04:00.000Z",
        refresh_token_expires_at: "2026-07-14T00:04:00.000Z",
        scopes: ["events:read"],
      }),
      deleteCredential: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "The refresh token has expired.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(1);
    expect(deleted).toBe(true);
    expect(stderr.join("\n")).toContain("The refresh token has expired.");
    expect(stderr.join("\n")).toContain("barestash auth login");
    expect(stderr.join("\n")).not.toContain("Failed to reach Barestash API.");
  });

  it("clears stored session credentials when refresh rejects a disabled account", async () => {
    const { io, stderr } = makeIo();
    let deleted = false;
    const exitCode = await runCli(["auth", "status"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "disabled-access",
        refresh_token: "disabled-refresh",
        access_token_expires_at: "2026-07-14T00:04:00.000Z",
        refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
        scopes: ["events:read"],
      }),
      deleteCredential: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "account_disabled",
              message: "The account is disabled.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(1);
    expect(deleted).toBe(true);
    expect(stderr.join("\n")).toContain("The account is disabled.");
    expect(stderr.join("\n")).toContain("barestash auth login");
    expect(stderr.join("\n")).not.toContain("Failed to reach Barestash API.");
  });

  it("preserves the refresh API error when credential cleanup fails", async () => {
    const { io, stderr } = makeIo();
    const exitCode = await runCli(["auth", "status"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "expired-access",
        refresh_token: "expired-refresh",
        access_token_expires_at: "2026-07-14T00:04:00.000Z",
        refresh_token_expires_at: "2026-07-14T00:04:00.000Z",
        scopes: ["events:read"],
      }),
      deleteCredential: async () => {
        throw new Error("native keyring library unavailable");
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "The refresh token has expired.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("The refresh token has expired.");
    expect(stderr.join("\n")).toContain(
      "Unable to clear the expired stored authentication credential.",
    );
    expect(stderr.join("\n")).not.toContain("Failed to reach Barestash API.");
  });

  it("reports unauthenticated JSON without the legacy token field", async () => {
    const { io, stdout } = makeIo();
    const exitCode = await runCli(["auth", "status", "--json"], io, {
      readConfig: async () =>
        JSON.stringify({ default_endpoint: "ep_public_default" }),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      authenticated: false,
      account: null,
      credential: null,
      default_endpoint: "ep_public_default",
    });
  });

  it("validates --with-token through GET /v1/account before storing it", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const writes: string[] = [];
    const exitCode = await runCli(["auth", "login", "--with-token"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readStdin: async () => "bst_pat_stdin\n",
      readConfig: async () => null,
      writeConfig: async (_path, value) => {
        writes.push(value);
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(accountResponse);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests[0].url).toBe("https://api.example.com/v1/account");
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer bst_pat_stdin",
    );
    expect(writes[0]).toContain("bst_pat_stdin");
    expect(stdout).toEqual(["Authenticated as user@example.com (tok_stdin)"]);
  });

  it("removes a migrated legacy config token after keyring persistence", async () => {
    const { io } = makeIo();
    const configWrites: string[] = [];
    const credentialWrites: StoredCredential[] = [];
    const exitCode = await runCli(["auth", "login", "--with-token"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readStdin: async () => "bst_pat_stdin",
      readCredential: async () => null,
      writeCredential: async (credential) => {
        credentialWrites.push(credential);
        return { storage: "keyring" };
      },
      readConfig: async () =>
        JSON.stringify({ token: "legacy-pat", default_endpoint: "ep_default" }),
      writeConfig: async (_path, value) => {
        configWrites.push(value);
      },
      fetch: async () => Response.json(accountResponse),
    });

    expect(exitCode).toBe(0);
    expect(credentialWrites).toEqual([
      { type: "personal_access_token", token: "bst_pat_stdin" },
    ]);
    expect(JSON.parse(configWrites.at(-1) ?? "null")).toEqual({
      default_endpoint: "ep_default",
    });
  });

  it("uses GET /v1/account as auth status source of truth", async () => {
    const { io, stdout } = makeIo();
    const paths: string[] = [];
    const exitCode = await runCli(["auth", "status", "--json"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readConfig: async () =>
        JSON.stringify({
          token: "stored-pat",
          default_endpoint: "ep_default",
        }),
      fetch: async (input, init) => {
        paths.push(new Request(input, init).url);
        return Response.json(accountResponse);
      },
    });

    expect(exitCode).toBe(0);
    expect(paths).toEqual(["https://api.example.com/v1/account"]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      authenticated: true,
      ...accountResponse,
      default_endpoint: "ep_default",
    });
  });

  it("surfaces expired PAT status without storing the credential", async () => {
    const { io, stderr } = makeIo();
    const writes: string[] = [];
    const exitCode = await runCli(["auth", "login", "--with-token"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readStdin: async () => "expired-pat",
      writeConfig: async (_path, value) => {
        writes.push(value);
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "personal_access_token_expired",
              message: "The Personal Access Token has expired.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(1);
    expect(writes).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "The Personal Access Token has expired.",
    );
    expect(stderr.join("\n")).toContain("barestash tokens create");
  });

  it("rejects CLI access tokens passed to auth login --with-token", async () => {
    const { io, stderr } = makeIo();
    const writes: string[] = [];
    const exitCode = await runCli(["auth", "login", "--with-token"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readStdin: async () => "bst_access_example",
      writeConfig: async (_path, value) => {
        writes.push(value);
      },
      fetch: async () =>
        Response.json({
          account: accountResponse.account,
          credential: {
            type: "cli_access_token",
            id: "atk_example",
            session_id: "cls_example",
            scopes: ["events:read"],
            expires_at: "2026-07-05T13:00:00.000Z",
          },
        } satisfies AccountResponse),
    });

    expect(exitCode).toBe(1);
    expect(writes).toEqual([]);
    expect(stderr.join("\n")).toContain("Personal Access Token");
  });

  it("revokes a stored PAT using the token id embedded in the bearer string", async () => {
    const { io, stdout } = makeIo();
    const requests: Request[] = [];
    const tokenId = testTokenId("pat_logout");
    const storedToken = formatPatBearerTokenString(
      tokenId,
      generateBearerTokenSecret({
        randomBytes: Uint8Array.from({ length: 32 }, () => 12),
      }),
    );
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readConfig: async () => JSON.stringify({ token: storedToken }),
      deleteConfig: async () => {},
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          token: {
            id: tokenId,
            name: null,
            status: "revoked",
            scopes: [],
            created_at: "2026-07-05T12:00:00.000Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: "2026-07-05T12:01:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["Logged out."]);
    expect(requests.map(({ url }) => url)).toEqual([
      `https://api.example.com/v1/tokens/${tokenId}`,
    ]);
  });

  it("resolves an unparsed stored PAT id through GET /v1/account before revoking", async () => {
    const { io, stdout } = makeIo();
    const tokenId = testTokenId("legacy_pat");
    const storedToken = "legacy-personal-access-token";
    let stored: StoredCredential | null = {
      type: "personal_access_token",
      token: storedToken,
    };
    const requests: Request[] = [];

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => stored,
      deleteCredential: async () => {
        stored = null;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/v1/account") {
          return Response.json({
            account: {
              id: "acc_test",
              primary_email: "user@example.com",
            },
            credential: {
              type: "personal_access_token",
              id: tokenId,
              scopes: ["events:read"],
              expires_at: null,
            },
          } satisfies AccountResponse);
        }
        return Response.json({
          token: {
            id: tokenId,
            name: null,
            status: "revoked",
            scopes: ["events:read"],
            created_at: "2026-07-05T12:00:00.000Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: "2026-07-05T12:01:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/account",
      `/v1/tokens/${tokenId}`,
    ]);
    expect(
      requests.map((request) => request.headers.get("authorization")),
    ).toEqual([`Bearer ${storedToken}`, `Bearer ${storedToken}`]);
    expect(stored).toBeNull();
    expect(stdout).toEqual(["Logged out."]);
  });

  it("does not resolve an unparsed PAT through a concurrently replaced credential", async () => {
    const { io, stdout, stderr } = makeIo();
    const originalToken = "legacy-personal-access-token";
    const replacement: StoredCredential = {
      type: "cli_session",
      session_id: "cls_replacement",
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      access_token_expires_at: "2026-07-14T01:00:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    let stored: StoredCredential | null = {
      type: "personal_access_token",
      token: originalToken,
    };
    const requests: Request[] = [];

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => stored,
      deleteCredential: async () => {
        stored = null;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        if (
          path === "/v1/account" &&
          authorization === `Bearer ${originalToken}`
        ) {
          stored = replacement;
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The original stored token has expired.",
              },
            },
            { status: 401 },
          );
        }
        if (path === "/v1/account") {
          return Response.json({
            account: {
              id: "acc_test",
              primary_email: "user@example.com",
            },
            credential: {
              type: "cli_access_token",
              id: "atk_replacement",
              session_id: "cls_replacement",
              scopes: ["events:read"],
              expires_at: "2026-07-14T01:00:00.000Z",
            },
          } satisfies AccountResponse);
        }
        if (authorization === `Bearer ${originalToken}`) {
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The original stored token has expired.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json({
          session: {
            id: "cls_replacement",
            status: "revoked",
            revoked_at: "2026-07-14T00:00:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(
      requests.map((request) => ({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      })),
    ).toEqual([
      {
        path: "/v1/account",
        authorization: `Bearer ${originalToken}`,
      },
    ]);
    expect(stored).toEqual(replacement);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "The original stored token has expired.",
    );
  });

  it("does not retry a resolved legacy session revoke with a replacement credential", async () => {
    const { io, stdout, stderr } = makeIo();
    const originalToken = "legacy-cli-access-token";
    const replacement: StoredCredential = {
      type: "cli_session",
      session_id: "cls_replacement",
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      access_token_expires_at: "2026-07-14T01:00:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    let stored: StoredCredential | null = {
      type: "personal_access_token",
      token: originalToken,
    };
    const requests: Request[] = [];

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => stored,
      deleteCredential: async () => {
        stored = null;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        if (path === "/v1/account") {
          stored = replacement;
          return Response.json({
            account: {
              id: "acc_test",
              primary_email: "user@example.com",
            },
            credential: {
              type: "cli_access_token",
              id: "atk_original",
              session_id: "cls_original",
              scopes: ["events:read"],
              expires_at: "2026-07-14T00:00:00.000Z",
            },
          } satisfies AccountResponse);
        }
        if (authorization === `Bearer ${originalToken}`) {
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The original stored token has expired.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json({
          session: {
            id: "cls_replacement",
            status: "revoked",
            revoked_at: "2026-07-14T00:00:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(
      requests.map((request) => ({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      })),
    ).toEqual([
      {
        path: "/v1/account",
        authorization: `Bearer ${originalToken}`,
      },
      {
        path: "/v1/auth/sessions/current/revoke",
        authorization: `Bearer ${originalToken}`,
      },
    ]);
    expect(stored).toEqual(replacement);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "The original stored token has expired.",
    );
  });

  it("surfaces account errors while resolving an unparsed stored PAT id", async () => {
    const { io, stdout, stderr } = makeIo();
    let deleted = false;
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => ({
        type: "personal_access_token",
        token: "legacy-personal-access-token",
      }),
      deleteCredential: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "invalid_token",
              message: "The stored token is invalid.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(1);
    expect(deleted).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("The stored token is invalid.");
    expect(stderr.join("\n")).not.toContain("Failed to reach Barestash API.");
  });

  it.each([
    "token_revoked",
    "personal_access_token_expired",
  ] as const)("treats account fallback %s as confirmed remote logout success", async (code) => {
    const { io, stdout } = makeIo();
    let deleted = false;
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => ({
        type: "personal_access_token",
        token: "legacy-personal-access-token",
      }),
      deleteCredential: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code,
              message: "The stored PAT is no longer active.",
            },
          },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(0);
    expect(deleted).toBe(true);
    expect(stdout).toEqual(["Logged out."]);
  });

  it("revokes the stored PAT even when BARESTASH_TOKEN is set", async () => {
    const { io } = makeIo();
    const storedId = testTokenId("stored_logout");
    const storedToken = formatPatBearerTokenString(storedId, "s".repeat(32));
    const environmentToken = formatPatBearerTokenString(
      testTokenId("environment"),
      "e".repeat(32),
    );
    const requests: Request[] = [];
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
        BARESTASH_TOKEN: environmentToken,
      },
      readConfig: async () => JSON.stringify({ token: storedToken }),
      deleteConfig: async () => {},
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          token: {
            id: storedId,
            name: null,
            status: "revoked",
            scopes: [],
            created_at: "2026-07-05T12:00:00.000Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: "2026-07-05T12:01:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(requests[0].url).toContain(`/v1/tokens/${storedId}`);
    expect(requests[0].headers.get("authorization")).toBe(
      `Bearer ${storedToken}`,
    );
  });

  it("does not delete a credential replaced while remote logout is in flight", async () => {
    const { io } = makeIo();
    const originalToken = formatPatBearerTokenString(
      testTokenId("logout_original"),
      "o".repeat(32),
    );
    const replacementToken = formatPatBearerTokenString(
      testTokenId("logout_replaced"),
      "n".repeat(32),
    );
    let stored: StoredCredential | null = {
      type: "personal_access_token",
      token: originalToken,
    };
    let deleteCalls = 0;

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => stored,
      deleteCredential: async () => {
        deleteCalls += 1;
        stored = null;
      },
      fetch: async () => {
        stored = {
          type: "personal_access_token",
          token: replacementToken,
        };
        return Response.json({
          token: {
            id: testTokenId("logout_original"),
            name: null,
            status: "revoked",
            scopes: [],
            created_at: "2026-07-05T12:00:00.000Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: "2026-07-05T12:01:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(stored).toEqual({
      type: "personal_access_token",
      token: replacementToken,
    });
  });

  it("revokes a stored CLI access token through the current session endpoint", async () => {
    const { io, stdout } = makeIo();
    const accessToken = formatBearerTokenString({
      type: "access",
      tokenIdSuffix: "ABCDEFGHIJKLMNOPQRSTUVWX",
      secret: "a".repeat(32),
    });
    const requests: Request[] = [];
    let deleted = false;
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readConfig: async () => JSON.stringify({ token: accessToken }),
      deleteConfig: async () => {
        deleted = true;
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          account: { id: "acc_test", primary_email: "user@example.com" },
          credential: {
            type: "cli_access_token",
            id: "atk_ABCDEFGHIJKLMNOPQRSTUVWX",
            session_id: "cls_test",
            scopes: ["events:read"],
            expires_at: "2026-07-05T13:00:00.000Z",
          },
        } satisfies AccountResponse);
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.example.com/v1/auth/sessions/current/revoke",
    ]);
    expect(deleted).toBe(true);
    expect(stdout).toEqual(["Logged out."]);
  });

  it.each([
    "session_expired",
    "session_revoked",
  ] as const)("treats refresh-time %s as confirmed remote logout success", async (code) => {
    const { io, stdout } = makeIo();
    let stored: StoredCredential | null = {
      type: "cli_session",
      session_id: "cls_test",
      access_token: "expired-access",
      refresh_token: "inactive-session-refresh",
      access_token_expires_at: "2026-07-14T00:30:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    const paths: string[] = [];
    let deleteCalls = 0;

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => stored,
      deleteCredential: async () => {
        deleteCalls += 1;
        stored = null;
      },
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        paths.push(path);
        if (path === "/v1/auth/token/refresh") {
          return Response.json(
            {
              error: {
                code,
                message: "The CLI session is no longer active.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json(
          {
            error: {
              code: "access_token_expired",
              message: "The access token has expired.",
            },
          },
          { status: 401 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(paths).toEqual([
      "/v1/auth/sessions/current/revoke",
      "/v1/auth/token/refresh",
    ]);
    expect(deleteCalls).toBe(1);
    expect(stored).toBeNull();
    expect(stdout).toEqual(["Logged out."]);
  });

  it.each([
    "token_revoked",
    "refresh_token_expired",
    "invalid_token",
  ] as const)("does not treat refresh-time %s as confirmed remote logout success", async (code) => {
    const { io, stdout, stderr } = makeIo();

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "expired-access",
        refresh_token: "unusable-refresh",
        access_token_expires_at: "2026-07-14T00:30:00.000Z",
        refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
        scopes: ["events:read"],
      }),
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        if (path === "/v1/auth/token/refresh") {
          return Response.json(
            {
              error: {
                code,
                message: "The refresh request cannot continue.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json(
          {
            error: {
              code: "access_token_expired",
              message: "The access token has expired.",
            },
          },
          { status: 401 },
        );
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("The refresh request cannot continue.");
  });

  it("deletes a CLI credential rotated after access_token_expired during revoke", async () => {
    const { io, stdout } = makeIo();
    let stored: StoredCredential | null = {
      type: "cli_session",
      session_id: "cls_test",
      access_token: "expired-access",
      refresh_token: "current-refresh",
      access_token_expires_at: "2026-07-14T00:30:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    const paths: string[] = [];
    let revokeCalls = 0;
    let deleteCalls = 0;

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => stored,
      replaceCredential: async (credential) => {
        stored = credential;
      },
      deleteCredential: async () => {
        deleteCalls += 1;
        stored = null;
      },
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        paths.push(path);
        if (path === "/v1/auth/token/refresh") {
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
          });
        }
        revokeCalls += 1;
        if (revokeCalls === 1) {
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The access token has expired.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json({
          session: {
            id: "cls_test",
            status: "revoked",
            revoked_at: "2026-07-14T00:00:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(paths).toEqual([
      "/v1/auth/sessions/current/revoke",
      "/v1/auth/token/refresh",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(deleteCalls).toBe(1);
    expect(stored).toBeNull();
    expect(stdout).toEqual(["Logged out."]);
  });

  it("revokes the rotated CLI session when credential persistence fails during logout", async () => {
    const { io, stderr } = makeIo();
    let stored: StoredCredential | null = {
      type: "cli_session",
      session_id: "cls_test",
      access_token: "expired-access",
      refresh_token: "current-refresh",
      access_token_expires_at: "2026-07-14T00:30:00.000Z",
      refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
      scopes: ["events:read"],
    };
    const requests: Request[] = [];
    let revokeCalls = 0;

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => stored,
      replaceCredential: async () => {
        throw new Error("Unable to persist rotated credentials.");
      },
      deleteCredential: async () => {
        stored = null;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/v1/auth/token/refresh") {
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
          });
        }
        revokeCalls += 1;
        if (revokeCalls === 1) {
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The access token has expired.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json({
          session: {
            id: "cls_test",
            status: "revoked",
            revoked_at: "2026-07-14T00:00:00.000Z",
          },
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/auth/sessions/current/revoke",
      "/v1/auth/token/refresh",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe(
      "Bearer rotated-access",
    );
    expect(stored).toBeNull();
    expect(stderr.join("\n")).toContain(
      "Unable to persist rotated credentials.",
    );
  });

  it("preserves the persistence error when rotated session cleanup fails", async () => {
    const { io, stderr } = makeIo();
    const requests: Request[] = [];
    let revokeCalls = 0;
    let deleteCalls = 0;

    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      readCredential: async () => ({
        type: "cli_session",
        session_id: "cls_test",
        access_token: "expired-access",
        refresh_token: "current-refresh",
        access_token_expires_at: "2026-07-14T00:30:00.000Z",
        refresh_token_expires_at: "2026-10-12T00:00:00.000Z",
        scopes: ["events:read"],
      }),
      replaceCredential: async () => {
        throw new Error("Unable to persist rotated credentials.");
      },
      deleteCredential: async () => {
        deleteCalls += 1;
        throw new Error("Unable to delete stale credentials.");
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/v1/auth/token/refresh") {
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
          });
        }
        revokeCalls += 1;
        if (revokeCalls === 1) {
          return Response.json(
            {
              error: {
                code: "access_token_expired",
                message: "The access token has expired.",
              },
            },
            { status: 401 },
          );
        }
        return Response.json(
          {
            error: {
              code: "internal_error",
              message: "Unable to revoke the rotated session.",
            },
          },
          { status: 500 },
        );
      },
    });

    expect(exitCode).toBe(1);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/auth/sessions/current/revoke",
      "/v1/auth/token/refresh",
      "/v1/auth/sessions/current/revoke",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe(
      "Bearer rotated-access",
    );
    expect(deleteCalls).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Unable to revoke the rotated CLI session after refresh persistence failed.",
    );
    expect(stderr.join("\n")).toContain(
      "Unable to clear the stale stored authentication credential after refresh persistence failed.",
    );
    expect(stderr.join("\n")).toContain(
      "Unable to persist rotated credentials.",
    );
    expect(stderr.join("\n")).not.toContain(
      "Unable to delete stale credentials.",
    );
  });

  it.each([
    "token_revoked",
    "personal_access_token_expired",
  ] as const)("treats %s as confirmed remote logout success", async (code) => {
    const { io, stdout } = makeIo();
    const tokenId = testTokenId("pat_retry");
    const storedToken = formatPatBearerTokenString(
      tokenId,
      generateBearerTokenSecret({
        randomBytes: Uint8Array.from({ length: 32 }, () => 9),
      }),
    );
    let deleted = false;
    const exitCode = await runCli(["auth", "logout", "--revoke"], io, {
      env: { BARESTASH_API_URL: "https://api.example.com" },
      readConfig: async () => JSON.stringify({ token: storedToken }),
      deleteConfig: async () => {
        deleted = true;
      },
      fetch: async () =>
        Response.json(
          { error: { code, message: "Already inactive." } },
          { status: 401 },
        ),
    });

    expect(exitCode).toBe(0);
    expect(deleted).toBe(true);
    expect(stdout).toEqual(["Logged out."]);
  });
});
