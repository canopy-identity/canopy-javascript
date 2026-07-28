import {
  CanopyConnectionError,
  CanopyError,
  type CanopyErrorBody,
} from "./errors.js";

/**
 * Offset pagination — the default across the API.
 */
export interface OffsetPagination {
  page: number;
  take: number;
  item_count: number;
  page_count: number;
  has_previous_page: boolean;
  has_next_page: boolean;
}

/**
 * Cursor pagination — used by append-heavy feeds (the audit log) where an
 * offset window drifts under concurrent writes.
 *
 * The envelope is identical to the offset case; only this object differs,
 * which is precisely why hand-written pagination loops break on one of them.
 */
export interface CursorPagination {
  next_cursor: string | null;
}

export type Pagination = OffsetPagination | CursorPagination;

export function isCursorPagination(
  pagination: Pagination,
): pagination is CursorPagination {
  return "next_cursor" in pagination;
}

/** A collection response, paginated or not. */
export interface Collection<T> {
  items: T[];
  pagination?: Pagination;
}

/** A 207 partial-success response from a bulk endpoint. */
export interface PartialSuccess<T> {
  summary: { total: number; succeeded: number; failed: number };
  results: {
    index: number;
    status: "success" | "error";
    code: number;
    data?: T;
    input?: unknown;
    error?: { code: string | null; message: string };
  }[];
}

export interface CanopyClientOptions {
  /**
   * Server-to-server credential (`cnpy_…`), sent as `X-API-Key`. Never ship
   * one to a browser: it carries whatever scopes it was issued with.
   */
  apiKey?: string;
  /** Identity or portal JWT, sent as `Authorization: Bearer`. */
  accessToken?: string;
  /** Defaults to Canopy's hosted API. Set this for a self-hosted instance. */
  baseUrl?: string;
  /** Per-attempt deadline. Defaults to 30s; 0 disables. */
  timeoutMs?: number;
  /** Retries after the first attempt. Defaults to 2. */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Declares this call safe to repeat, which allows retrying a 5xx.
   *
   * Needed because the OpenAPI document only marks one operation
   * `x-canopy-idempotent`, so the spec cannot drive this. GET, HEAD, PUT and
   * DELETE are treated as idempotent by HTTP definition; POST is not, and a
   * blind retry there can create a second role assignment or a second
   * invitation. Set this only when the endpoint genuinely tolerates a repeat.
   */
  idempotent?: boolean;
}

const DEFAULT_BASE_URL = "https://auth.canopy-io.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

/** Idempotent by HTTP definition (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/**
 * The transport every resource is built on: one place that knows how to
 * authenticate, unwrap Canopy's response envelope, turn a failure into a typed
 * error, and decide whether repeating a request is safe.
 *
 * Deliberately dependency-free — `fetch` only — so the same client runs on
 * Node 18+, in browsers, on Workers and on Deno.
 */
export class CanopyClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly authHeaders: Record<string, string>;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CanopyClientOptions = {}) {
    if (!options.apiKey && !options.accessToken) {
      throw new TypeError(
        "CanopyClient requires either `apiKey` (server-to-server) or `accessToken` (a user or identity JWT).",
      );
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new TypeError(
        "No `fetch` available. Node 18+ provides one; on older runtimes pass `fetch` explicitly.",
      );
    }

    this.authHeaders = options.apiKey
      ? { "X-API-Key": options.apiKey }
      : { Authorization: `Bearer ${options.accessToken ?? ""}` };
  }

  /**
   * Issue a request and return the payload with the envelope removed.
   *
   *   `{ data }`               → the resource
   *   `{ items, pagination }`  → the whole object, so pagination survives
   *   `{ summary, results }`   → the whole object
   *   204                      → undefined
   *
   * Non-2xx throws `CanopyError`; a request that never completed throws
   * `CanopyConnectionError`.
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const upper = method.toUpperCase();
    const retryable = options.idempotent ?? IDEMPOTENT_METHODS.has(upper);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(backoffMs(attempt, lastError));
      }

      try {
        const response = await this.send(upper, url, options);

        if (this.shouldRetry(response.status, retryable, attempt)) {
          lastError = await this.toError(response, upper, path);
          continue;
        }

        if (!response.ok) {
          throw await this.toError(response, upper, path);
        }

        return await this.unwrap<T>(response);
      } catch (error) {
        // A typed API error is the server's answer, not a transport problem —
        // it is never retried here, only by the branch above.
        if (error instanceof CanopyError) {
          throw error;
        }

        lastError = error;

        // Nothing is known about whether a non-idempotent request took effect,
        // so it must not be repeated.
        if (!retryable || attempt === this.maxRetries) {
          throw new CanopyConnectionError(
            `${upper} ${path} failed: ${describe(error)}`,
            { method: upper, path },
            { cause: error },
          );
        }
      }
    }

    // Loop exits only via return or throw; this satisfies the type checker and
    // would indicate a logic error if it were ever reached.
    throw new CanopyConnectionError(
      `${upper} ${path} exhausted ${this.maxRetries + 1} attempts`,
      { method: upper, path },
      { cause: lastError },
    );
  }

  private shouldRetry(
    status: number,
    retryable: boolean,
    attempt: number,
  ): boolean {
    if (attempt >= this.maxRetries) {
      return false;
    }

    // 429 means the request was refused before doing anything, so repeating it
    // is safe regardless of method.
    if (status === 429) {
      return true;
    }

    return status >= 500 && retryable;
  }

  private async send(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    // Forward a caller's abort without requiring AbortSignal.any, which is not
    // available on every runtime this package supports.
    const onAbort = () => controller.abort();

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.extraHeaders,
      ...this.authHeaders,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // Built conditionally rather than passing `body: undefined`, which
    // `exactOptionalPropertyTypes` rejects and which some runtimes treat as a
    // body on GET.
    const init: RequestInit = { method, headers, signal: controller.signal };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    try {
      return await this.fetchImpl(url, init);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    const url = new URL(
      path.startsWith("/") ? path : `/${path}`,
      `${this.baseUrl}/`,
    );

    for (const [key, value] of Object.entries(query ?? {})) {
      // Absent and null are both "no filter" — sending `?take=null` would be
      // a validation error rather than a default.
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private async unwrap<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();

    if (text === "") {
      return undefined as T;
    }

    const parsed = JSON.parse(text) as Record<string, unknown>;

    // `{ data }` is the single-resource envelope; everything else is returned
    // whole, because its extra keys (pagination, summary) are the point.
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      return parsed["data"] as T;
    }

    return parsed as T;
  }

  private async toError(
    response: Response,
    method: string,
    path: string,
  ): Promise<CanopyError> {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    let body: CanopyErrorBody = {
      statusCode: response.status,
      code: null,
      message: `${response.status} ${response.statusText}`.trim(),
    };

    try {
      const parsed = JSON.parse(await response.text()) as {
        error?: CanopyErrorBody;
      };

      if (parsed.error) {
        body = {
          ...parsed.error,
          statusCode: parsed.error.statusCode ?? response.status,
        };
      }
    } catch {
      // A non-JSON body (a proxy's HTML error page) leaves the status-derived
      // message above, which is more useful than the raw markup.
    }

    const error = new CanopyError(body, { method, path });

    if (retryAfter !== null) {
      Object.defineProperty(error, "retryAfterMs", {
        value: retryAfter,
        enumerable: true,
      });
    }

    return error;
  }
}

/** `Retry-After` is either seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(header);

  if (Number.isNaN(date)) {
    return null;
  }

  return Math.max(0, date - Date.now());
}

/**
 * Exponential backoff with jitter, but the server's own `Retry-After` wins —
 * it knows when the window resets and we are guessing.
 *
 * Jitter matters when many workers hit the same limit at once: without it they
 * all wake together and rate-limit each other again.
 */
function backoffMs(attempt: number, lastError: unknown): number {
  const advised =
    lastError && typeof lastError === "object" && "retryAfterMs" in lastError
      ? Number((lastError as { retryAfterMs: unknown }).retryAfterMs)
      : NaN;

  if (Number.isFinite(advised)) {
    return advised;
  }

  const base = 250 * 2 ** (attempt - 1);

  return base + Math.random() * base;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timed out or aborted" : error.message;
  }

  return String(error);
}
