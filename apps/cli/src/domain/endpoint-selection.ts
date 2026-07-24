/** @public */
export function selectedEndpointId(
  endpointFlag: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  return endpointFlag ?? env.BARESTASH_ENDPOINT ?? null;
}
