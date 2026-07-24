import type { AuthPrincipal } from "@barestash/shared/auth";
import { generateBearerTokenSecret } from "@barestash/shared/bearer-tokens";
import type {
  AccessTokenId,
  CliSessionId,
  DeviceAuthorizationId,
  EndpointId,
  EventId,
  PatIdempotencyId,
  RefreshTokenId,
  SecretId,
  TokenId,
} from "@barestash/shared/ids";
import {
  generateAccessTokenId,
  generateCliSessionId,
  generateDeviceAuthorizationId,
  generateRefreshTokenId,
  generateEndpointId as generateSharedEndpointId,
  generateEventId as generateSharedEventId,
  generatePatIdempotencyId as generateSharedPatIdempotencyId,
  generateSecretId as generateSharedSecretId,
  generateTokenId as generateSharedTokenId,
} from "@barestash/shared/ids";
import type { PrincipalAuthenticationResult } from "./application/auth.js";
import {
  formatAccessToken,
  formatRefreshToken,
  generateDeviceCode,
  generateUserCode,
} from "./application/device-authorization.js";
import type { RateLimitBinding } from "./application/rate-limit.js";
import type { AuthDomainRepository } from "./domain/auth-domain.js";
import { generateEndpointSecret } from "./domain/endpoint-secret.js";
import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
  EventStreamCoordinator,
  RequestBodyStore,
} from "./domain/ports.js";
import { generateTokenSecret } from "./domain/token.js";
import { D1AuthDomainRepository } from "./infrastructure/d1/auth-domain-repository.js";
import { D1EndpointRepository } from "./infrastructure/d1/endpoint-repository.js";
import { D1EndpointSecretRepository } from "./infrastructure/d1/endpoint-secret-repository.js";
import { D1EventRepository } from "./infrastructure/d1/event-repository.js";
import { DurableObjectEventStreamCoordinator } from "./infrastructure/durable-objects/event-stream-coordinator.js";
import {
  MissingRequestBodyStore,
  R2RequestBodyStore,
} from "./infrastructure/r2/request-body-store.js";

export type Bindings = {
  DB?: D1Database;
  REQUEST_BODIES?: R2Bucket;
  ENDPOINT_STREAMS?: DurableObjectNamespace;
  BARESTASH_ENVIRONMENT?: string;
  BARESTASH_CREDENTIAL_PEPPER?: string;
  BARESTASH_API_HOSTNAME?: string;
  BARESTASH_INGEST_HOSTNAME?: string;
  BARESTASH_APP_ORIGIN?: string;
  ABUSE_IP_RATE_LIMITER?: RateLimit;
  INGEST_ENDPOINT_RATE_LIMITER?: RateLimit;
  ENDPOINT_CREATION_RATE_LIMITER?: RateLimit;
  PAT_WRITE_RATE_LIMITER?: RateLimit;
  REFRESH_RATE_LIMITER?: RateLimit;
  DEVICE_CREATION_RATE_LIMITER?: RateLimit;
  DEVICE_POLL_RATE_LIMITER?: RateLimit;
  MCP_RATE_LIMITER?: RateLimit;
  WRITE_RATE_LIMITER?: RateLimit;
  SSE_RATE_LIMITER?: RateLimit;
};

export const RATE_LIMIT_BINDING_NAMES = [
  "ABUSE_IP_RATE_LIMITER",
  "INGEST_ENDPOINT_RATE_LIMITER",
  "ENDPOINT_CREATION_RATE_LIMITER",
  "PAT_WRITE_RATE_LIMITER",
  "REFRESH_RATE_LIMITER",
  "DEVICE_CREATION_RATE_LIMITER",
  "DEVICE_POLL_RATE_LIMITER",
  "MCP_RATE_LIMITER",
  "WRITE_RATE_LIMITER",
  "SSE_RATE_LIMITER",
] as const;

export type RateLimitBindingName = (typeof RATE_LIMIT_BINDING_NAMES)[number];

export type ApiEnv = {
  Bindings: Bindings;
  Variables: {
    authenticatedMcpTokenId?: string;
    authenticatedMcpPrincipal?: AuthPrincipal;
    authenticatedWriteCredentialId?: string;
    writeAuthentication?: PrincipalAuthenticationResult;
  };
};

export type CreateApiAppOptions = {
  endpointRepository?: EndpointRepository;
  endpointSecretRepository?: EndpointSecretRepository;
  eventRepository?: EventRepository;
  requestBodyStore?: RequestBodyStore;
  streamCoordinator?: EventStreamCoordinator;
  authDomainRepository?: AuthDomainRepository;
  now?: () => Date;
  generateEndpointId?: () => EndpointId;
  generateEventId?: () => EventId;
  generateSecretId?: () => SecretId;
  generateTokenId?: () => TokenId;
  generatePatIdempotencyId?: () => PatIdempotencyId;
  generateDeviceAuthorizationId?: () => DeviceAuthorizationId;
  generateCliSessionId?: () => CliSessionId;
  generateAccessTokenId?: () => AccessTokenId;
  generateRefreshTokenId?: () => RefreshTokenId;
  generateDeviceCode?: () => string;
  generateUserCode?: () => string;
  generateAccessToken?: (id: AccessTokenId) => string;
  generateRefreshToken?: (id: RefreshTokenId) => string;
  generateEndpointSecret?: () => string;
  generateTokenSecret?: (tokenId: TokenId) => string;
  rateLimiters?: Partial<Record<RateLimitBindingName, RateLimitBinding>>;
};

export type AppDeps = {
  options: CreateApiAppOptions;
  getNow: () => Date;
  makeEndpointId: () => EndpointId;
  makeEventId: () => EventId;
  makeSecretId: () => SecretId;
  makeTokenId: () => TokenId;
  makePatIdempotencyId: () => PatIdempotencyId;
  makeDeviceAuthorizationId: () => DeviceAuthorizationId;
  makeCliSessionId: () => CliSessionId;
  makeAccessTokenId: () => AccessTokenId;
  makeRefreshTokenId: () => RefreshTokenId;
  makeDeviceCode: () => string;
  makeUserCode: () => string;
  makeAccessToken: (id: AccessTokenId) => string;
  makeRefreshToken: (id: RefreshTokenId) => string;
  makeEndpointSecret: () => string;
  makeTokenSecret: (tokenId: TokenId) => string;
};

export function createAppDeps(options: CreateApiAppOptions = {}): AppDeps {
  return {
    options,
    getNow: options.now ?? (() => new Date()),
    makeEndpointId: options.generateEndpointId ?? generateSharedEndpointId,
    makeEventId: options.generateEventId ?? generateSharedEventId,
    makeSecretId: options.generateSecretId ?? generateSharedSecretId,
    makeTokenId: options.generateTokenId ?? generateSharedTokenId,
    makePatIdempotencyId:
      options.generatePatIdempotencyId ?? generateSharedPatIdempotencyId,
    makeDeviceAuthorizationId:
      options.generateDeviceAuthorizationId ?? generateDeviceAuthorizationId,
    makeCliSessionId: options.generateCliSessionId ?? generateCliSessionId,
    makeAccessTokenId: options.generateAccessTokenId ?? generateAccessTokenId,
    makeRefreshTokenId:
      options.generateRefreshTokenId ?? generateRefreshTokenId,
    makeDeviceCode: options.generateDeviceCode ?? generateDeviceCode,
    makeUserCode: options.generateUserCode ?? generateUserCode,
    makeAccessToken:
      options.generateAccessToken ??
      ((id) => formatAccessToken(id, generateBearerTokenSecret())),
    makeRefreshToken:
      options.generateRefreshToken ??
      ((id) => formatRefreshToken(id, generateBearerTokenSecret())),
    makeEndpointSecret:
      options.generateEndpointSecret ?? generateEndpointSecret,
    makeTokenSecret: options.generateTokenSecret ?? generateTokenSecret,
  };
}

function missingDependency(name: string): never {
  throw new Error(`${name} is not configured.`);
}

export function getRateLimiter(
  context: { env?: Bindings },
  deps: AppDeps,
  name: RateLimitBindingName,
): RateLimitBinding {
  return (
    deps.options.rateLimiters?.[name] ??
    context.env?.[name] ??
    missingDependency(`Rate Limiting binding ${name}`)
  );
}

export function getEndpointRepository(
  context: { env?: Bindings },
  deps: AppDeps,
): EndpointRepository {
  if (deps.options.endpointRepository !== undefined) {
    return deps.options.endpointRepository;
  }

  if (context.env?.DB === undefined) {
    return missingDependency("Endpoint repository");
  }

  return new D1EndpointRepository(context.env.DB);
}

export function getEndpointSecretRepository(
  context: { env?: Bindings },
  deps: AppDeps,
): EndpointSecretRepository {
  if (deps.options.endpointSecretRepository !== undefined) {
    return deps.options.endpointSecretRepository;
  }

  if (context.env?.DB === undefined) {
    return missingDependency("Endpoint secret repository");
  }

  return new D1EndpointSecretRepository(context.env.DB);
}

export function getEventRepository(
  context: { env?: Bindings },
  deps: AppDeps,
): EventRepository {
  if (deps.options.eventRepository !== undefined) {
    return deps.options.eventRepository;
  }

  if (context.env?.DB === undefined) {
    return missingDependency("Event repository");
  }

  return new D1EventRepository(context.env.DB);
}

export function getRequestBodyStore(
  context: { env?: Bindings },
  deps: AppDeps,
): RequestBodyStore {
  if (deps.options.requestBodyStore !== undefined) {
    return deps.options.requestBodyStore;
  }

  if (
    context.env?.REQUEST_BODIES === undefined &&
    context.env?.DB !== undefined
  ) {
    return new MissingRequestBodyStore();
  }

  if (context.env?.REQUEST_BODIES === undefined) {
    return missingDependency("Request body store");
  }

  return new R2RequestBodyStore(context.env.REQUEST_BODIES);
}

export function getStreamCoordinator(
  context: { env?: Bindings },
  deps: AppDeps,
): EventStreamCoordinator {
  if (deps.options.streamCoordinator !== undefined) {
    return deps.options.streamCoordinator;
  }

  if (context.env?.ENDPOINT_STREAMS !== undefined) {
    return new DurableObjectEventStreamCoordinator(
      context.env.ENDPOINT_STREAMS,
    );
  }

  return missingDependency("Event stream coordinator");
}

export function getAuthDomainRepository(
  context: { env?: Bindings },
  deps: AppDeps,
): AuthDomainRepository {
  if (deps.options.authDomainRepository !== undefined) {
    return deps.options.authDomainRepository;
  }

  if (context.env?.DB === undefined) {
    return missingDependency("Auth domain repository");
  }

  return new D1AuthDomainRepository(context.env.DB);
}

export function getCredentialPepper(context: { env?: Bindings }): string {
  return context.env?.BARESTASH_CREDENTIAL_PEPPER ?? "";
}
