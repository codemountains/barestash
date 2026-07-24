/** @public */
export type CliConfig = {
  token?: string;
  default_endpoint?: string;
};

/** @public */
export function resolveConfigPath(
  env: Record<string, string | undefined>,
  platformName: string,
  homeDirectory: string,
): string {
  if (env.BARESTASH_CONFIG_FILE !== undefined) {
    return env.BARESTASH_CONFIG_FILE;
  }

  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0) {
    return `${env.XDG_CONFIG_HOME}/barestash/config.json`;
  }

  if (platformName === "darwin") {
    return `${homeDirectory}/Library/Application Support/barestash/config.json`;
  }

  if (platformName === "win32") {
    const appData = env.APPDATA ?? `${homeDirectory}/AppData/Roaming`;
    return `${appData}/barestash/config.json`;
  }

  return `${homeDirectory}/.config/barestash/config.json`;
}

/** @public */
export function parseConfig(text: string | null): CliConfig {
  if (text === null || text.trim() === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    return typeof parsed === "object" && parsed !== null
      ? (parsed as CliConfig)
      : {};
  } catch {
    return {};
  }
}

/** @public */
export function serializeConfig(config: CliConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
