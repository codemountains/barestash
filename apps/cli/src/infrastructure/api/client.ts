import type { RestErrorResponse } from "@barestash/shared/errors";
import type { CliFetch } from "../../domain/ports.js";

/** @public */
export type ApiCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; error: RestErrorResponse };

/** @public */
export class FetchApiClient {
  readonly #fetch: CliFetch;
  readonly #getBaseUrl: () => string;
  readonly #signal?: AbortSignal;
  #accessTokenExpiredHandler?: (expiredToken: string) => Promise<string | null>;

  constructor(fetch: CliFetch, getBaseUrl: () => string, signal?: AbortSignal) {
    this.#fetch = fetch;
    this.#getBaseUrl = getBaseUrl;
    this.#signal = signal;
  }

  setAccessTokenExpiredHandler(
    handler: (expiredToken: string) => Promise<string | null>,
  ): void {
    this.#accessTokenExpiredHandler = handler;
  }

  url(path: string): string {
    return new URL(path, this.#getBaseUrl()).toString();
  }

  async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiCallResult<T>> {
    const result = await this.requestWithoutAccessTokenRefresh<T>(path, init);
    if (
      result.kind !== "error" ||
      result.error.error.code !== "access_token_expired" ||
      this.#accessTokenExpiredHandler === undefined
    ) {
      return result;
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (authorization?.startsWith("Bearer ") !== true) return result;
    const refreshedToken = await this.#accessTokenExpiredHandler(
      authorization.slice("Bearer ".length),
    );
    if (refreshedToken === null) return result;
    headers.set("authorization", `Bearer ${refreshedToken}`);
    return this.requestWithoutAccessTokenRefresh<T>(path, {
      ...init,
      headers,
    });
  }

  async requestWithoutAccessTokenRefresh<T>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiCallResult<T>> {
    const response = await this.#fetch(this.url(path), this.withSignal(init));
    return this.resultFromResponse<T>(response);
  }

  async resultFromResponse<T>(response: Response): Promise<ApiCallResult<T>> {
    let body: T | RestErrorResponse;

    try {
      body = (await response.json()) as T | RestErrorResponse;
    } catch {
      return {
        kind: "error",
        error: {
          error: {
            code: "internal_error",
            message:
              "Barestash API returned a response that was not valid JSON.",
          },
        },
      };
    }

    if (!response.ok) {
      return {
        kind: "error",
        error: body as RestErrorResponse,
      };
    }

    return {
      kind: "ok",
      value: body as T,
    };
  }

  async requestRaw(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.#fetch(this.url(path), this.withSignal(init));
    if (
      response.status !== 401 ||
      this.#accessTokenExpiredHandler === undefined
    ) {
      return response;
    }
    let code: string | undefined;
    try {
      const body = (await response
        .clone()
        .json()) as Partial<RestErrorResponse>;
      code = body.error?.code;
    } catch {
      return response;
    }
    if (code !== "access_token_expired") return response;
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (authorization?.startsWith("Bearer ") !== true) return response;
    const refreshedToken = await this.#accessTokenExpiredHandler(
      authorization.slice("Bearer ".length),
    );
    if (refreshedToken === null) return response;
    headers.set("authorization", `Bearer ${refreshedToken}`);
    return this.#fetch(this.url(path), this.withSignal({ ...init, headers }));
  }

  private withSignal(init?: RequestInit): RequestInit | undefined {
    if (this.#signal === undefined) {
      return init;
    }

    return { ...init, signal: this.#signal };
  }
}
