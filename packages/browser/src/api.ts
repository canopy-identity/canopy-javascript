import { CanopyAuthError, CanopyConnectionError } from "./errors.js";

/** What a held read needs from the client: where the API is and a token. */
export interface ApiDeps {
  /** The API origin: the issuer's. */
  apiOrigin: () => string;
  /** A current access token, or null when nobody is signed in. */
  accessToken: () => Promise<string | null>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** Something held changed: a wrapper re-reads. */
  changed: () => void;
}

/**
 * How long a failed read waits before a new call may ask again. A failure is
 * kept rather than retried on every render, so a page that renders often
 * cannot turn an outage or a rate limit into a stream of requests.
 */
export const FAILED_CHECK_RETRY_MS = 30_000;

/**
 * One call to the signed-in person's own routes, with the token as a bearer.
 * A refusal throws `CanopyAuthError` with the API's code and any
 * `Retry-After`; no answer at all throws `CanopyConnectionError`.
 */
export async function apiRequest(
  deps: Pick<ApiDeps, "apiOrigin" | "fetch">,
  path: string,
  token: string,
  init: { method: string; body?: string },
): Promise<unknown> {
  const url = `${deps.apiOrigin()}${path}`;
  let response: Response;

  try {
    response = await deps.fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (caught) {
    throw new CanopyConnectionError(url, caught);
  }

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const failure = (parsed as { error?: { code?: string; message?: string } })
      .error;
    const retryAfter = Number(response.headers.get("retry-after"));

    throw new CanopyAuthError(
      failure?.code ?? "server_error",
      failure?.message,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  return parsed;
}

/** Any failure as one of the package's two errors. */
export function asCanopyError(
  caught: unknown,
): CanopyAuthError | CanopyConnectionError {
  return caught instanceof CanopyAuthError ||
    caught instanceof CanopyConnectionError
    ? caught
    : new CanopyAuthError("server_error", String(caught));
}

/** When a failed read may be asked again: 30 seconds, or longer if `Retry-After` says so. */
export function retryAtFor(
  error: CanopyAuthError | CanopyConnectionError,
  now: number,
): number {
  const retryAfterMs =
    error instanceof CanopyAuthError && error.retryAfterSeconds !== undefined
      ? error.retryAfterSeconds * 1000
      : 0;

  return now + Math.max(FAILED_CHECK_RETRY_MS, retryAfterMs);
}
