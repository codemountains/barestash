import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebApp } from "../app.js";
import type { WebEnvironment } from "./auth.js";

let sqlite: DatabaseSync | undefined;

describe("OAuth callback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite?.close();
    sqlite = undefined;
  });

  it("provisions one domain account and strips provider tokens before D1 persistence", async () => {
    const database = await createDatabase();
    const fetchMock = githubFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const app = createWebApp(environment(database));
    const start = await app.request("https://app.example.com/sign-in/github", {
      method: "POST",
      headers: { Origin: "https://app.example.com" },
    });
    const providerRedirect = new URL(start.headers.get("location") ?? "");
    const state = providerRedirect.searchParams.get("state");

    expect(start.status).toBe(302);
    expect(providerRedirect.origin).toBe("https://github.com");
    expect(state).not.toBeNull();

    const callback = await app.request(
      `https://app.example.com/api/auth/callback/github?code=example-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { Cookie: cookieHeader(start.headers) } },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("accounts")).toBe(1);
    expect(rowCount("identities")).toBe(1);
    expect(rowCount("better_auth_account_mappings")).toBe(1);
    expect(
      sqlite
        ?.prepare(
          "SELECT provider, provider_subject FROM identities WHERE provider = 'github'",
        )
        .get(),
    ).toEqual({ provider: "github", provider_subject: "123456" });
    expect(
      sqlite
        ?.prepare(
          `SELECT accessToken, refreshToken, idToken
        FROM "account" WHERE providerId = 'github'`,
        )
        .get(),
    ).toEqual({ accessToken: null, refreshToken: null, idToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("provisions a Google identity through the same domain path", async () => {
    const database = await createDatabase();
    const fetchMock = googleFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const app = createWebApp(environment(database));
    const start = await app.request("https://app.example.com/sign-in/google", {
      method: "POST",
      headers: { Origin: "https://app.example.com" },
    });
    const providerRedirect = new URL(start.headers.get("location") ?? "");
    const state = providerRedirect.searchParams.get("state");

    expect(start.status).toBe(302);
    expect(providerRedirect.origin).toBe("https://accounts.google.com");
    expect(state).not.toBeNull();

    const callback = await app.request(
      `https://app.example.com/api/auth/callback/google?code=example-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { Cookie: cookieHeader(start.headers) } },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("accounts")).toBe(1);
    expect(rowCount("identities")).toBe(1);
    expect(
      sqlite
        ?.prepare(
          "SELECT provider, provider_subject FROM identities WHERE provider = 'google'",
        )
        .get(),
    ).toEqual({ provider: "google", provider_subject: "google-subject-123" });
    expect(
      sqlite
        ?.prepare(
          `SELECT accessToken, refreshToken, idToken
        FROM "account" WHERE providerId = 'google'`,
        )
        .get(),
    ).toEqual({ accessToken: null, refreshToken: null, idToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects implicit Google linking when a GitHub user has the same verified email", async () => {
    const database = await createDatabase();
    const app = createWebApp(environment(database));
    vi.stubGlobal("fetch", githubFetchMock());

    const github = await completeOAuth(app, "github-code");

    expect(github.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("user")).toBe(1);
    expect(rowCount("account")).toBe(1);
    expect(rowCount("accounts")).toBe(1);
    expect(rowCount("identities")).toBe(1);

    vi.stubGlobal("fetch", googleFetchMock());
    const google = await completeGoogleOAuth(app, "google-code");

    expect(google.status).toBe(302);
    expect(google.headers.get("location")).toContain(
      "error=account_not_linked",
    );
    expect(rowCount("user")).toBe(1);
    expect(rowCount("account")).toBe(1);
    expect(rowCount("accounts")).toBe(1);
    expect(rowCount("identities")).toBe(1);
    expect(
      sqlite
        ?.prepare("SELECT provider FROM identities")
        .all()
        .map((row) => row.provider),
    ).toEqual(["github"]);
  });

  it("removes a partial Better Auth user so a failed first sign-in can be retried", async () => {
    const database = await createDatabase();
    database.failNextAccountInsert();
    vi.stubGlobal("fetch", githubFetchMock());
    const app = await createWebApp(environment(database));

    const first = await completeOAuth(app, "first-code");

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain(
      "error=unable_to_create_user",
    );
    expect(rowCount("user")).toBe(0);
    expect(rowCount("account")).toBe(0);
    expect(rowCount("session")).toBe(0);

    const retry = await completeOAuth(app, "retry-code");

    expect(retry.status).toBe(302);
    expect(retry.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("user")).toBe(1);
    expect(rowCount("account")).toBe(1);
    expect(rowCount("session")).toBe(1);
    expect(rowCount("accounts")).toBe(1);
    expect(rowCount("identities")).toBe(1);
    expect(rowCount("better_auth_account_mappings")).toBe(1);
  });

  it("recovers a stale partial user when both the account insert and compensating delete fail", async () => {
    const database = await createDatabase();
    database.failNextAccountInsert();
    database.failNextUserDelete();
    vi.stubGlobal("fetch", githubFetchMock());
    const app = await createWebApp(environment(database));

    const first = await completeOAuth(app, "first-code");

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain(
      "error=unable_to_create_user",
    );
    expect(rowCount("user")).toBe(1);
    expect(rowCount("account")).toBe(0);
    expect(rowCount("session")).toBe(0);

    const immediateRetry = await completeOAuth(app, "immediate-retry-code");

    expect(immediateRetry.headers.get("location")).toContain(
      "error=account_not_linked",
    );
    expect(rowCount("user")).toBe(1);

    sqlite
      ?.prepare(`UPDATE "user" SET "createdAt" = datetime('now', '-2 minutes')`)
      .run();

    const retry = await completeOAuth(app, "retry-code");

    expect(retry.status).toBe(302);
    expect(retry.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("user")).toBe(1);
    expect(rowCount("account")).toBe(1);
    expect(rowCount("session")).toBe(1);
  });

  it("does not persist a browser session when domain provisioning fails", async () => {
    const database = await createDatabase({ includeDomainSchema: false });
    vi.stubGlobal("fetch", githubFetchMock());
    const app = await createWebApp(environment(database));

    const callback = await completeOAuth(app, "missing-domain-schema");

    expect(callback.status).toBe(500);
    expect(rowCount("session")).toBe(0);
  });

  it("blocks disabled account-linking routes before OAuth state or rate-limit bypass", async () => {
    const database = await createDatabase();
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal("fetch", githubFetchMock());
    const app = await createWebApp(environment(database, rateLimit));
    const callback = await completeOAuth(app, "sign-in-code");

    expect(callback.headers.get("location")).toBe("https://app.example.com/");
    expect(rowCount("verification")).toBe(0);

    const link = await app.request(
      "https://app.example.com/api/auth/link-social",
      {
        method: "POST",
        headers: {
          Cookie: cookieHeader(callback.headers),
          "Content-Type": "application/json",
          Origin: "https://app.example.com",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/device?code=raw-user-code",
        }),
      },
    );
    const unlink = await app.request(
      "https://app.example.com/api/auth/unlink-account",
      {
        method: "POST",
        headers: {
          Cookie: cookieHeader(callback.headers),
          "Content-Type": "application/json",
          Origin: "https://app.example.com",
        },
        body: JSON.stringify({ providerId: "github" }),
      },
    );

    expect(link.status).toBe(404);
    expect(unlink.status).toBe(404);
    expect(rowCount("verification")).toBe(0);
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });
});

function environment(
  database: SqliteD1Database,
  rateLimit = vi.fn().mockResolvedValue({ success: true }),
): WebEnvironment {
  return {
    DB: database as never,
    OAUTH_RATE_LIMITER: {
      limit: rateLimit,
    } as never,
    DEVICE_APPROVAL_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    } as never,
    BARESTASH_APP_ORIGIN: "https://app.example.com",
    BARESTASH_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "a".repeat(32),
    BARESTASH_CREDENTIAL_PEPPER: "pepper",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
  };
}

async function createDatabase(
  options: { includeDomainSchema?: boolean } = {},
): Promise<SqliteD1Database> {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (options.includeDomainSchema !== false) {
    sqlite.exec(
      await readFile(
        new URL(
          "../../../../api/migrations/0003_auth_domain_foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  sqlite.exec(
    await readFile(
      new URL("../../../migrations/0001_better_auth.sql", import.meta.url),
      "utf8",
    ),
  );

  return new SqliteD1Database(sqlite);
}

async function completeOAuth(
  app: Awaited<ReturnType<typeof createWebApp>>,
  code: string,
): Promise<Response> {
  const start = await app.request("https://app.example.com/sign-in/github", {
    method: "POST",
    headers: { Origin: "https://app.example.com" },
  });
  const providerRedirect = new URL(start.headers.get("location") ?? "");
  const state = providerRedirect.searchParams.get("state") ?? "";

  return app.request(
    `https://app.example.com/api/auth/callback/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookieHeader(start.headers) } },
  );
}

async function completeGoogleOAuth(
  app: Awaited<ReturnType<typeof createWebApp>>,
  code: string,
): Promise<Response> {
  const start = await app.request("https://app.example.com/sign-in/google", {
    method: "POST",
    headers: { Origin: "https://app.example.com" },
  });
  const providerRedirect = new URL(start.headers.get("location") ?? "");
  const state = providerRedirect.searchParams.get("state") ?? "";

  return app.request(
    `https://app.example.com/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookieHeader(start.headers) } },
  );
}

function githubFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );

    if (url.href === "https://github.com/login/oauth/access_token") {
      return jsonResponse({
        access_token: "raw-access-token-marker",
        refresh_token: "raw-refresh-token-marker",
        id_token: "raw-id-token-marker",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: "read:user user:email",
        token_type: "bearer",
      });
    }

    if (url.href === "https://api.github.com/user") {
      return jsonResponse({
        id: "123456",
        login: "example-user",
        name: "Example User",
        email: "user@example.com",
        avatar_url: "https://avatars.githubusercontent.com/u/123456",
      });
    }

    if (url.href === "https://api.github.com/user/emails") {
      return jsonResponse([
        {
          email: "user@example.com",
          primary: true,
          verified: true,
          visibility: "private",
        },
      ]);
    }

    throw new Error(`Unexpected GitHub request: ${url.href}`);
  });
}

function googleFetchMock() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: "jwk" });

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );

    if (url.href === "https://oauth2.googleapis.com/token") {
      return jsonResponse({
        access_token: "raw-google-access-token-marker",
        refresh_token: "raw-google-refresh-token-marker",
        id_token: googleIdToken(privateKey),
        expires_in: 3600,
        token_type: "Bearer",
      });
    }

    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") {
      return jsonResponse({
        keys: [{ ...publicJwk, kid: "google-test-key", alg: "RS256" }],
      });
    }

    throw new Error(`Unexpected Google request: ${url.href}`);
  });
}

function googleIdToken(privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({
    alg: "RS256",
    kid: "google-test-key",
    typ: "JWT",
  });
  const payload = base64UrlJson({
    iss: "https://accounts.google.com",
    aud: "google-client-id",
    sub: "google-subject-123",
    email: "user@example.com",
    email_verified: true,
    name: "Example Google User",
    picture: "https://example.com/google-avatar.png",
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function cookieHeader(headers: Headers): string {
  const getSetCookie = (
    headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  const cookies = getSetCookie?.call(headers) ?? [
    headers.get("set-cookie") ?? "",
  ];

  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function rowCount(table: string): number {
  return Number(
    sqlite?.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count ?? 0,
  );
}

class SqliteD1Database {
  private shouldFailNextAccountInsert = false;
  private shouldFailNextUserDelete = false;

  constructor(private readonly database: DatabaseSync) {}

  failNextAccountInsert(): void {
    this.shouldFailNextAccountInsert = true;
  }

  failNextUserDelete(): void {
    this.shouldFailNextUserDelete = true;
  }

  prepare(query: string) {
    const statement = this.database.prepare(query);
    let values: unknown[] = [];
    const execute = () => {
      if (
        this.shouldFailNextAccountInsert &&
        /\binsert\b[\s\S]*\baccount\b/i.test(query)
      ) {
        this.shouldFailNextAccountInsert = false;
        throw new Error("injected account insert failure");
      }

      if (
        this.shouldFailNextUserDelete &&
        /\bdelete\b[\s\S]*\buser\b/i.test(query)
      ) {
        this.shouldFailNextUserDelete = false;
        throw new Error("injected user delete failure");
      }

      return executeStatement(statement, query, values);
    };

    return {
      bind: (...bindings: unknown[]) => {
        values = bindings.map(normalizeBinding);
        return {
          all: async () => execute(),
          first: async <T>() =>
            (statement.get(...values) as T | undefined) ?? null,
          run: async () => execute(),
        };
      },
      all: async () => execute(),
      first: async <T>() => (statement.get(...values) as T | undefined) ?? null,
      run: async () => execute(),
    };
  }

  async batch(statements: Array<{ all: () => Promise<unknown> }>) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(query: string) {
    this.database.exec(query);
  }
}

function executeStatement(
  statement: ReturnType<DatabaseSync["prepare"]>,
  query: string,
  values: unknown[],
) {
  if (
    /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query) ||
    /\bRETURNING\b/i.test(query)
  ) {
    return {
      results: statement.all(...values),
      meta: { changes: 0, last_row_id: null },
      success: true,
    };
  }

  const result = statement.run(...values);
  return {
    results: [],
    meta: {
      changes: Number(result.changes),
      last_row_id: Number(result.lastInsertRowid),
    },
    success: true,
  };
}

function normalizeBinding(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}
