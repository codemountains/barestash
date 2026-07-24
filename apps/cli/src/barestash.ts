#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";

import type { CliIo } from "./domain/ports.js";

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { runCliProcess } = await import("./process.js");

  process.exitCode = await runCliProcess(process.argv.slice(2), {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  } satisfies CliIo);
}
