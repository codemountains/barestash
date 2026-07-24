import { AUTHORIZATION_SCOPES } from "@barestash/shared/auth";
import type { CreateEndpointRequest } from "@barestash/shared/endpoints";
import type { PersonalAccessTokenCreateRequest } from "@barestash/shared/personal-access-tokens";
import * as z from "zod/v4";

export class InvalidJsonRequestError extends Error {}
export class InvalidRequestBodyError extends Error {}

const createEndpointRequestSchema = z.object({
  mode: z.enum(["private", "temporary"]).optional(),
  name: z.string().optional(),
});

const createTokenRequestSchema = z.object({
  name: z.string().optional(),
  scopes: z
    .array(z.enum(AUTHORIZATION_SCOPES))
    .default(AUTHORIZATION_SCOPES.slice()),
  expires_in: z.number().int().positive().nullable().optional(),
});

function parseRequestBody<T>(
  body: unknown,
  schema: z.ZodType<T>,
  fieldMessages: Readonly<Record<string, string>>,
): T {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError("Request body must be a JSON object.");
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const message =
      typeof field === "string" ? fieldMessages[field] : undefined;

    throw new InvalidRequestBodyError(
      message ?? "Request body does not match the expected schema.",
    );
  }

  return parsed.data;
}

export async function readCreateEndpointRequest(
  request: Request,
): Promise<CreateEndpointRequest> {
  if (
    request.headers.get("content-type")?.includes("application/json") !== true
  ) {
    return {};
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new InvalidJsonRequestError();
  }

  return parseRequestBody(body, createEndpointRequestSchema, {
    mode: 'Endpoint mode must be "private" or "temporary".',
    name: "Endpoint name must be a string.",
  }) satisfies CreateEndpointRequest;
}

export async function readCreateTokenRequest(
  request: Request,
): Promise<PersonalAccessTokenCreateRequest> {
  if (
    request.headers.get("content-type")?.includes("application/json") !== true
  ) {
    return { scopes: AUTHORIZATION_SCOPES.slice() };
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new InvalidJsonRequestError();
  }

  return parseRequestBody(body, createTokenRequestSchema, {
    name: "Token name must be a string.",
    scopes: "Token scopes must contain only supported scope names.",
    expires_in: "Token expires_in must be a positive integer or null.",
  }) satisfies PersonalAccessTokenCreateRequest;
}

export function getAuthorizationHeader(request: Request): string | null {
  return request.headers.get("authorization");
}

export function getLastEventIdHeader(request: Request): string | null {
  return request.headers.get("last-event-id");
}
