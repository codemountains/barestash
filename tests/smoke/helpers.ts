import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashCredential } from "../../apps/api/src/application/credential-hash.js";
import { AUTHORIZATION_SCOPES } from "../../packages/shared/src/auth.js";
import {
  formatPatBearerTokenString,
  parseBearerTokenString,
} from "../../packages/shared/src/bearer-tokens.js";
import {
  TOKEN_ID_SUFFIX_LENGTH,
  type TokenId,
} from "../../packages/shared/src/ids.js";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
export const API_DIR = join(REPO_ROOT, "apps/api");
const SMOKE_CREDENTIAL_PEPPER =
  "local-dev-credential-pepper-not-for-production";

function testTokenId(label: string): TokenId {
  const alphanumeric = label.replace(/[^A-Za-z0-9]/g, "");
  const suffix = (alphanumeric + "0".repeat(TOKEN_ID_SUFFIX_LENGTH)).slice(
    0,
    TOKEN_ID_SUFFIX_LENGTH,
  );

  return `tok_${suffix}` as TokenId;
}

const SMOKE_OWNER_PAT_ID = testTokenId("smoke_owner");
const SMOKE_OWNER_PAT = formatPatBearerTokenString(
  SMOKE_OWNER_PAT_ID,
  "smokeownerpat0123456789abcdefghi",
);

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve a free port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

export async function waitForHealth(
  baseUrl: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Wrangler may still be booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `API did not become ready at ${baseUrl} within ${timeoutMs}ms.`,
  );
}

export type SmokeApiServer = {
  baseUrl: string;
  ownerPat: string;
  port: number;
  persistTo: string;
  process: ChildProcess;
  stop: () => Promise<void>;
};

export async function startSmokeApiServer(
  port: number,
): Promise<SmokeApiServer> {
  const persistTo = await mkdtemp(join(tmpdir(), "barestash-smoke-"));

  await execFileAsync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "barestash",
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      "wrangler.toml",
    ],
    {
      cwd: API_DIR,
      env: smokeWranglerEnv(persistTo),
    },
  );

  await seedSmokeOwnerPat(persistTo);

  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "wrangler.toml",
      "--persist-to",
      persistTo,
      "--port",
      String(port),
      "--var",
      `BARESTASH_CREDENTIAL_PEPPER:${SMOKE_CREDENTIAL_PEPPER}`,
    ],
    {
      cwd: API_DIR,
      env: smokeWranglerEnv(persistTo),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-20_000);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    await stopProcess(child);
    await rm(persistTo, { force: true, recursive: true });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }

  return {
    baseUrl,
    ownerPat: SMOKE_OWNER_PAT,
    port,
    persistTo,
    process: child,
    stop: async () => {
      await stopProcess(child);
      await rm(persistTo, { force: true, recursive: true });
    },
  };
}

async function seedSmokeOwnerPat(persistTo: string): Promise<void> {
  const parsed = parseBearerTokenString(SMOKE_OWNER_PAT);
  if (parsed?.type !== "pat") throw new Error("Invalid smoke owner PAT.");
  const tokenHash = await hashCredential(parsed.secret, {
    pepper: SMOKE_CREDENTIAL_PEPPER,
  });
  const now = "2026-07-15T00:00:00.000Z";
  const sql = [
    `INSERT INTO accounts (id, primary_email, display_name, avatar_url, status, created_at, updated_at) VALUES ('acc_smoke_owner', 'smoke@example.invalid', 'Smoke Owner', NULL, 'active', '${now}', '${now}')`,
    `INSERT INTO personal_access_tokens (id, account_id, name, token_hash, status, scopes_json, created_at, expires_at, last_used_at, revoked_at) VALUES ('${SMOKE_OWNER_PAT_ID}', 'acc_smoke_owner', 'smoke-owner', '${tokenHash}', 'active', '${JSON.stringify(AUTHORIZATION_SCOPES)}', '${now}', NULL, NULL, NULL)`,
  ].join(";");

  await execFileAsync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "barestash",
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      "wrangler.toml",
      "--command",
      sql,
    ],
    { cwd: API_DIR, env: smokeWranglerEnv(persistTo) },
  );
}

function smokeWranglerEnv(persistTo: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: "1",
    XDG_CONFIG_HOME: join(persistTo, "wrangler-config"),
    WRANGLER_LOG_PATH: join(persistTo, "wrangler-logs"),
  };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export type CliRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const SMOKE_EMPTY_CONFIG_FILE = join(
  tmpdir(),
  "barestash-smoke-empty-config.json",
);

function smokeCliEnv(
  env: Record<string, string>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    // Isolate smoke runs from the developer's stored CLI credentials.
    BARESTASH_CONFIG_FILE: SMOKE_EMPTY_CONFIG_FILE,
    BARESTASH_TOKEN: "",
    BARESTASH_ENDPOINT: "",
    ...env,
  };
}

export async function runBarestashCli(
  args: string[],
  env: Record<string, string>,
): Promise<CliRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["barestash", ...args],
      {
        cwd: REPO_ROOT,
        env: smokeCliEnv(env),
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return {
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    ) {
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }

    throw error;
  }
}

export type RunningCli = {
  process: ChildProcess;
  getStdout: () => string;
  getStderr: () => string;
  getSpawnError: () => Error | null;
  stop: () => Promise<void>;
};

export function startBarestashCli(
  args: string[],
  env: Record<string, string>,
): RunningCli {
  const child = spawn("pnpm", ["barestash", ...args], {
    cwd: REPO_ROOT,
    env: smokeCliEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError: Error | null = null;

  child.on("error", (error) => {
    spawnError = error;
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    process: child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    getSpawnError: () => spawnError,
    stop: async () => {
      await stopProcess(child);
    },
  };
}

export class CliOutputTimeoutError extends Error {
  constructor(timeoutMs: number, stdout: string, stderr: string) {
    super(
      [
        `CLI did not produce expected output within ${timeoutMs}ms.`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n"),
    );
    this.name = "CliOutputTimeoutError";
  }
}

export class CliExitedError extends Error {
  constructor(
    exitCode: number | null,
    signalCode: ChildProcess["signalCode"],
    stdout: string,
    stderr: string,
  ) {
    super(
      [
        "CLI exited before matching expected output.",
        `exitCode=${String(exitCode)}`,
        `signalCode=${String(signalCode)}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n"),
    );
    this.name = "CliExitedError";
  }
}

export class CliSpawnError extends Error {
  constructor(cause: Error, stdout: string, stderr: string) {
    super(
      [
        "CLI failed to start.",
        cause.message,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n"),
      { cause },
    );
    this.name = "CliSpawnError";
  }
}

export async function waitForCliOutput(
  cli: RunningCli,
  match: RegExp | ((stdout: string) => boolean),
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const matches =
    typeof match === "function"
      ? match
      : (stdout: string) => match.test(stdout);

  while (Date.now() < deadline) {
    const stdout = cli.getStdout();

    if (matches(stdout)) {
      return stdout;
    }

    const spawnError = cli.getSpawnError();

    if (spawnError !== null) {
      throw new CliSpawnError(spawnError, cli.getStdout(), cli.getStderr());
    }

    if (cli.process.exitCode !== null || cli.process.signalCode !== null) {
      throw new CliExitedError(
        cli.process.exitCode,
        cli.process.signalCode,
        cli.getStdout(),
        cli.getStderr(),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new CliOutputTimeoutError(timeoutMs, cli.getStdout(), cli.getStderr());
}
