import type { Hono } from "hono";

import { createApiApp } from "../app.js";
import {
  type ApiEnv,
  type CreateApiAppOptions,
  RATE_LIMIT_BINDING_NAMES,
} from "../container.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../infrastructure/in-memory/endpoint-repository.js";
import { InMemoryEndpointSecretRepository } from "../infrastructure/in-memory/endpoint-secret-repository.js";
import { InMemoryEventRepository } from "../infrastructure/in-memory/event-repository.js";
import { InMemoryEventStreamCoordinator } from "../infrastructure/in-memory/event-stream-coordinator.js";
import { InMemoryRequestBodyStore } from "../infrastructure/in-memory/request-body-store.js";

const allowRateLimiter = {
  async limit() {
    return { success: true };
  },
};

/** @public */
export function createTestApiApp(
  options: CreateApiAppOptions = {},
): Hono<ApiEnv> {
  const endpointRepository =
    options.endpointRepository ?? new InMemoryEndpointRepository();
  const endpointSecretRepository =
    options.endpointSecretRepository ?? new InMemoryEndpointSecretRepository();
  const rateLimiters = Object.fromEntries(
    RATE_LIMIT_BINDING_NAMES.map((name) => [name, allowRateLimiter]),
  );

  return createApiApp(
    {
      ...options,
      endpointRepository,
      endpointSecretRepository,
      eventRepository:
        options.eventRepository ??
        new InMemoryEventRepository({
          endpointRepository,
          endpointSecretRepository,
        }),
      requestBodyStore:
        options.requestBodyStore ?? new InMemoryRequestBodyStore(),
      streamCoordinator:
        options.streamCoordinator ?? new InMemoryEventStreamCoordinator(),
      authDomainRepository:
        options.authDomainRepository ?? new InMemoryAuthDomainRepository(),
      rateLimiters: {
        ...rateLimiters,
        ...options.rateLimiters,
      },
    },
    {
      validateRuntimeBindings: false,
    },
  );
}
