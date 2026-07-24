import type { EndpointId, EventId } from "@barestash/shared/ids";

import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
  EventStreamCoordinator,
  RequestBodyStore,
} from "../../domain/ports.js";
import type { CredentialPepperDeps } from "../auth.js";

export type IngestDeps = CredentialPepperDeps & {
  endpointRepository: EndpointRepository;
  endpointSecretRepository: EndpointSecretRepository;
  eventRepository: EventRepository;
  requestBodyStore: RequestBodyStore;
  streamCoordinator: EventStreamCoordinator;
  getNow: () => Date;
  makeEventId: () => EventId;
  endpointId: EndpointId;
  request: Request;
};
