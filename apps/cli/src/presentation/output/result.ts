import type { CliResult } from "../../application/result.js";
import type { CliIo } from "../../domain/ports.js";
import { printApiError, printLocalError } from "./errors.js";

/** @public */
export function handleCliResult<T>(result: CliResult<T>, io: CliIo): T | null {
  if (result.kind === "ok") {
    return result.value;
  }

  if (result.kind === "api-error") {
    printApiError(io, result.error);
    return null;
  }

  printLocalError(io, result.message);
  return null;
}

export function cliResultExitCode<T>(result: CliResult<T>): number {
  return result.kind === "ok" ? 0 : 1;
}
