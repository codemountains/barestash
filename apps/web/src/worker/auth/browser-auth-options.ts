import type { BetterAuthOptions } from "better-auth";

export type BrowserAuthEnvironment = {
  DB: D1Database;
  OAUTH_RATE_LIMITER: RateLimit;
  DEVICE_APPROVAL_RATE_LIMITER: RateLimit;
  BARESTASH_APP_ORIGIN: string;
  BARESTASH_ENVIRONMENT: "development" | "staging" | "production";
  BETTER_AUTH_SECRET: string;
  BARESTASH_CREDENTIAL_PEPPER: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

type BrowserAuthHooks = {
  provisionForSession?: (betterAuthUserId: string) => Promise<void>;
};

export function redactProviderAccount<T extends Record<string, unknown>>(
  account: T,
) {
  return {
    data: {
      ...account,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
    },
  };
}

export function createBrowserAuthOptions(
  environment: BrowserAuthEnvironment,
  hooks: BrowserAuthHooks = {},
): BetterAuthOptions {
  const appOrigin = validatedAppOrigin(environment);

  return {
    appName: "Barestash",
    baseURL: appOrigin,
    basePath: "/api/auth",
    database: environment.DB,
    secret: requiredBetterAuthSecret(
      environment.BETTER_AUTH_SECRET,
      "BETTER_AUTH_SECRET",
    ),
    logger: { disabled: true },
    trustedOrigins: [appOrigin],
    socialProviders: {
      github: {
        clientId: requiredSecret(
          environment.GITHUB_CLIENT_ID,
          "GITHUB_CLIENT_ID",
        ),
        clientSecret: requiredSecret(
          environment.GITHUB_CLIENT_SECRET,
          "GITHUB_CLIENT_SECRET",
        ),
      },
      google: {
        clientId: requiredSecret(
          environment.GOOGLE_CLIENT_ID,
          "GOOGLE_CLIENT_ID",
        ),
        clientSecret: requiredSecret(
          environment.GOOGLE_CLIENT_SECRET,
          "GOOGLE_CLIENT_SECRET",
        ),
      },
    },
    account: {
      storeStateStrategy: "database",
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
      accountLinking: { enabled: false, disableImplicitLinking: true },
    },
    advanced: {
      useSecureCookies: appOrigin.startsWith("https://"),
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: appOrigin.startsWith("https://"),
        sameSite: "lax",
      },
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => redactProviderAccount(account) },
        update: { before: async (account) => redactProviderAccount(account) },
      },
      session: {
        create: {
          before: async (session) => {
            if (hooks.provisionForSession !== undefined) {
              await hooks.provisionForSession(session.userId);
            }
          },
        },
      },
    },
  };
}

function validatedAppOrigin(environment: BrowserAuthEnvironment): string {
  const url = new URL(environment.BARESTASH_APP_ORIGIN);

  if (
    url.origin !== environment.BARESTASH_APP_ORIGIN.replace(/\/$/, "") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("BARESTASH_APP_ORIGIN must be an origin without a path.");
  }

  if (
    environment.BARESTASH_ENVIRONMENT !== "development" &&
    url.protocol !== "https:"
  ) {
    throw new Error("BARESTASH_APP_ORIGIN must use HTTPS outside development.");
  }

  return url.origin;
}

function requiredSecret(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be configured.`);
  }

  return value;
}

function requiredBetterAuthSecret(value: string, name: string): string {
  if (value.trim().length < 32) {
    throw new Error(
      `${name} must contain at least 32 non-whitespace characters.`,
    );
  }

  return value;
}
