import type { CliIo } from "../../domain/ports.js";

/** @public */
export function printJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2));
}

/** @public */
export function printJsonLine(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value));
}
