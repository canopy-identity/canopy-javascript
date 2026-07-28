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
  /**
   * Ceiling on a single wait between attempts. Defaults to 30s.
   *
   * The server's `Retry-After` is honoured up to this, then clamped. Without a
   * cap the wait is whatever a response header asks for, which sits outside
   * `timeoutMs` and can hold a caller far longer than its own budget allows.
   */
  maxBackoffMs?: number;
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
   * Per-attempt deadline for this call only, overriding the client-wide
   * `timeoutMs`. 0 disables it.
   *
   * The client-wide default suits administrative CRUD. A latency-critical call
   * on a request path — an authorization check on every inbound request — wants
   * a much tighter one, because the total time at risk is this deadline times
   * the attempts, and it is spent holding an inbound request open.
   */
  timeoutMs?: number;
  /**
   * Retries after the first attempt for this call only, overriding the
   * client-wide `maxRetries`. 0 disables retrying.
   *
   * Set this together with `timeoutMs` when a call needs a bounded worst case:
   * the two multiply. A deadline alone still permits `maxRetries + 1` of them
   * back to back, which is the difference between a slow call and a request
   * held open long past the point the answer was useful.
   */
  maxRetries?: number;
  /**
   * Ceiling on a single wait between attempts, for this call only.
   *
   * Set it alongside `timeoutMs` and `maxRetries` when a call needs a real
   * worst case: the deadline bounds an attempt, `maxRetries` bounds how many,
   * and this bounds the waiting in between — which a server's `Retry-After`
   * would otherwise control.
   */
  maxBackoffMs?: number;
  /**
   * Headers for this call only, overriding the client-wide `headers`.
   *
   * This is how the per-request protocol headers are sent: `If-Match`, carrying
   * a resource's current `version` for optimistic concurrency (a stale value
   * answers 409), and `Idempotency-Key`, which makes a replayed bulk create
   * return the original result instead of creating rows twice.
   *
   * The credential is not overridable this way — auth is settled by the client.
   */
  headers?: Record<string, string>;
  /**
   * Declares this call safe to repeat, which allows retrying a 5xx.
   *
   * Needed because the generated types carry no idempotency marker, so the
   * spec cannot drive this. GET, HEAD, PUT and DELETE are treated as
   * idempotent by HTTP definition; POST is not, and a blind retry there can
   * create a second role assignment or a second invitation.
   *
   * Set it where a POST is a read in disguise — the permission evaluations
   * take a body and so must be POSTs, but they compute an answer and write
   * nothing. Do not set it on anything that creates.
   */
  idempotent?: boolean;
}

/**
 * The per-call knobs a resource method accepts.
 *
 * Deliberately excludes `body` and `query`, which the method itself owns, and
 * `idempotent`, which is a property of the endpoint rather than the call site.
 */
export type CallOptions = Pick<
  RequestOptions,
  "signal" | "timeoutMs" | "maxRetries" | "maxBackoffMs" | "headers"
>;

const DEFAULT_BASE_URL = "https://auth.canopy-io.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

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
  private readonly maxBackoffMs: number;
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
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
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
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const maxBackoffMs = options.maxBackoffMs ?? this.maxBackoffMs;

    // Cancelled before it began: never reach the network at all. Relying on
    // `fetch` to reject an aborted signal would still cost the call.
    throwIfAborted(options.signal);

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(
          backoffMs(attempt, lastError, maxBackoffMs),
          options.signal,
        );

        // Abort during the backoff window: stop here rather than spending an
        // attempt on a request the caller no longer wants.
        throwIfAborted(options.signal);
      }

      try {
        const response = await this.send(upper, url, options);

        if (this.shouldRetry(response.status, retryable, attempt, maxRetries)) {
          lastError = await this.toError(response, upper, path);
          continue;
        }

        if (!response.ok) {
          throw await this.toError(response, upper, path);
        }

        return await this.unwrap<T>(response, upper, path);
      } catch (error) {
        // A typed API error is the server's answer, not a transport problem —
        // it is never retried here, only by the branch above.
        if (error instanceof CanopyError) {
          throw error;
        }

        lastError = error;

        // A caller's abort is a deliberate cancellation, not a transport
        // hiccup: never retry it, and surface the abort itself rather than a
        // generic connection error. The per-attempt timeout uses a separate
        // internal controller, so `options.signal` is aborted only when the
        // caller asked to stop — a timeout still falls through to the retry
        // logic below.
        throwIfAborted(options.signal);

        // Nothing is known about whether a non-idempotent request took effect,
        // so it must not be repeated.
        if (!retryable || attempt === maxRetries) {
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
      `${upper} ${path} exhausted ${maxRetries + 1} attempts`,
      { method: upper, path },
      { cause: lastError },
    );
  }

  private shouldRetry(
    status: number,
    retryable: boolean,
    attempt: number,
    maxRetries: number,
  ): boolean {
    if (attempt >= maxRetries) {
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
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    // Forward a caller's abort without requiring AbortSignal.any, which is not
    // available on every runtime this package supports. A signal that is
    // already aborted would never re-fire the event, so honour it up front.
    const onAbort = () => controller.abort();

    if (options.signal?.aborted) {
      controller.abort();
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.extraHeaders,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // Per-request headers beat the client-wide defaults, but the credential is
    // applied last so no call site can accidentally send a different one.
    Object.assign(headers, options.headers, this.authHeaders);

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

  private async unwrap<T>(
    response: Response,
    method: string,
    path: string,
  ): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();

    if (text === "") {
      return undefined as T;
    }

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A 2xx with a body that is not JSON — usually a proxy or gateway that
      // answered instead of the API. The connection succeeded, so this is not a
      // CanopyConnectionError; report it as the malformed API response it is.
      throw new CanopyError(
        {
          statusCode: response.status,
          code: null,
          message: `${method} ${path} returned ${response.status} with a body that is not JSON.`,
        },
        { method, path },
      );
    }

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

    return new CanopyError(body, { method, path }, retryAfter ?? undefined);
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
function backoffMs(
  attempt: number,
  lastError: unknown,
  maxBackoffMs: number,
): number {
  const advised =
    lastError && typeof lastError === "object" && "retryAfterMs" in lastError
      ? Number(lastError.retryAfterMs)
      : NaN;

  if (Number.isFinite(advised)) {
    // Capped, because this number comes off a response header and is otherwise
    // unbounded: a `Retry-After: 120` would hold the caller for two minutes,
    // outside any per-attempt deadline. Waiting less than advised risks another
    // 429, which is a retry we are already budgeted for; waiting the full
    // amount risks a request pinned open for as long as the header says.
    return Math.min(advised, maxBackoffMs);
  }

  const base = 250 * 2 ** (attempt - 1);

  return Math.min(base + Math.random() * base, maxBackoffMs);
}

/**
 * Stop immediately if the caller has cancelled, surfacing their own reason.
 *
 * `AbortSignal.throwIfAborted` would do this, but it is not available on every
 * runtime this package supports, and neither is a guaranteed `reason`.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw (
    signal.reason ??
    new DOMException("This operation was aborted", "AbortError")
  );
}

/**
 * Wait, but stop early if the caller cancels.
 *
 * A plain timer would hold the wait to completion and only notice the abort
 * afterwards — and with a server-advised `Retry-After` that wait can be far
 * longer than any per-attempt deadline, so "cancelled" would mean "cancelled,
 * in a minute". Resolving early lets the caller's abort be observed at once;
 * the throw itself stays with `throwIfAborted`.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // Held in one object because a timer implementation may invoke its callback
    // synchronously — a test double often does. `finish` would then run before
    // the handle exists, so it reads the handle through `state` rather than
    // closing over a binding that is not assigned yet, and `settled` keeps the
    // abort listener from outliving a wait that already finished.
    const state: {
      timer?: ReturnType<typeof setTimeout>;
      settled: boolean;
    } = { settled: false };

    const finish = () => {
      if (state.settled) {
        return;
      }

      state.settled = true;

      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }

      signal?.removeEventListener("abort", finish);
      resolve();
    };

    state.timer = setTimeout(finish, ms);

    if (!state.settled) {
      signal?.addEventListener("abort", finish, { once: true });
    }
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // A caller's abort is rethrown before it reaches here, so an AbortError at
    // this point came from the per-attempt timeout.
    return error.name === "AbortError" ? "timed out" : error.message;
  }

  return String(error);
}
