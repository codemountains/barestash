import { describe, expect, it, vi } from "vitest";

import {
  type BrowserAuthEnvironment,
  createBrowserAuthOptions,
  redactProviderAccount,
} from "./browser-auth-options.js";

const environment = {
  DB: {} as D1Database,
  BARESTASH_APP_ORIGIN: "https://app.example.com",
  BARESTASH_ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: "a".repeat(32),
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
} satisfies BrowserAuthEnvironment;

describe("redactProviderAccount", () => {
  it("sets every provider credential field to null before account persistence", () => {
    const result = redactProviderAccount({
      providerId: "github",
      accountId: "123456",
      accessToken: "raw-access-token-marker",
      refreshToken: "raw-refresh-token-marker",
      idToken: "raw-id-token-marker",
      accessTokenExpiresAt: new Date("2026-07-14T12:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-08-13T12:00:00.000Z"),
      scope: "read:user user:email",
    });

    expect(result).toEqual({
      data: {
        providerId: "github",
        accountId: "123456",
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
      },
    });
  });
});

describe("createBrowserAuthOptions", () => {
  it("uses the fixed app origin and strict browser authentication settings", async () => {
    const provisionForSession = vi.fn().mockResolvedValue(undefined);
    const options = createBrowserAuthOptions(environment, {
      provisionForSession,
    });

    expect(options).toMatchObject({
      appName: "Barestash",
      baseURL: "https://app.example.com",
      basePath: "/api/auth",
      database: environment.DB,
      trustedOrigins: ["https://app.example.com"],
      socialProviders: {
        github: {
          clientId: "github-client-id",
          clientSecret: "github-client-secret",
        },
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        },
      },
      account: {
        storeStateStrategy: "database",
        storeAccountCookie: false,
        updateAccountOnSignIn: false,
        accountLinking: { enabled: false, disableImplicitLinking: true },
      },
      advanced: {
        useSecureCookies: true,
        disableCSRFCheck: false,
        disableOriginCheck: false,
        defaultCookieAttributes: {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        },
      },
      logger: { disabled: true },
    });

    await options.databaseHooks?.session?.create?.before?.(
      { userId: "better-auth-user-1" } as never,
      null,
    );

    expect(provisionForSession).toHaveBeenCalledWith("better-auth-user-1");
  });

  it("uses the token-redaction hook for both account inserts and updates", async () => {
    const options = createBrowserAuthOptions(environment);
    const account = {
      providerId: "github",
      accountId: "123456",
      accessToken: "raw-access-token-marker",
      refreshToken: "raw-refresh-token-marker",
      idToken: "raw-id-token-marker",
    };

    const create = await options.databaseHooks?.account?.create?.before?.(
      account as never,
      null,
    );
    const update = await options.databaseHooks?.account?.update?.before?.(
      account as never,
      null,
    );

    expect(create).toMatchObject({
      data: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    });
    expect(update).toMatchObject({
      data: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    });
  });

  it("does not permit an insecure browser origin outside local development", () => {
    expect(() =>
      createBrowserAuthOptions({
        ...environment,
        BARESTASH_APP_ORIGIN: "http://app.example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("requires a Better Auth secret with at least 32 characters", () => {
    expect(() =>
      createBrowserAuthOptions({
        ...environment,
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).toThrow(/at least 32/);
  });
});
