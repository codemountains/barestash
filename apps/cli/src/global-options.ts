export function parseGlobalCliOptions(args: string[]): {
  allowInsecureApiUrl: boolean;
  commandArgs: string[];
} {
  const commandArgs: string[] = [];
  let allowInsecureApiUrl = false;

  for (const arg of args) {
    if (arg === "--allow-insecure-api-url") {
      allowInsecureApiUrl = true;
      continue;
    }

    commandArgs.push(arg);
  }

  return {
    allowInsecureApiUrl,
    commandArgs,
  };
}
