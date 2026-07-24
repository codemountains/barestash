/** @public */
export function parsePollInterval(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);

  if (match === null) {
    throw new Error("Poll interval must include a unit: ms, s, or m.");
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (unit === "ms") {
    return amount;
  }

  if (unit === "s") {
    return amount * 1000;
  }

  return amount * 60 * 1000;
}

/** @public */
export function parseTokenDurationSeconds(value: string): number {
  const match = /^(\d+)(d|y)$/.exec(value);

  if (match === null) {
    throw new Error("Token expiration must include a unit: d or y.");
  }

  const amount = Number(match[1]);

  if (amount <= 0) {
    throw new Error("Token expiration must be a positive duration.");
  }

  const days = match[2] === "y" ? amount * 365 : amount;
  return days * 24 * 60 * 60;
}
