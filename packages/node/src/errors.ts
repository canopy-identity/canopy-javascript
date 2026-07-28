/**
 * Everything this client throws.
 *
 * Two classes, because callers act on the distinction: `CanopyError` means the
 * API answered and said no, `CanopyConnectionError` means it never answered.
 * The first is a decision you may need to surface to a user; the second is
 * usually worth retrying or alerting on.
 */

/** The `error` object inside Canopy's error envelope. */
export interface CanopyErrorBody {
  statusCode: number;
  /**
   * Stable machine-readable code, e.g. `rbac.assignment_conflict`. Null on
   * framework-level failures such as a validation 400, where `details` carries
   * the specifics instead.
   */
  code: string | null;
  message: string;
  timestamp?: string;
  path?: string;
  method?: string;
  /** Field-level validation messages, present on a 400. */
  details?: string[];
  /** Structured payload for specific codes — a version conflict carries the current row. */
  data?: unknown;
}

/**
 * The API returned a non-2xx response.
 *
 * Branch on `code` rather than `message`: the code is a contract, the message
 * is prose that may be reworded.
 */
export class CanopyError extends Error {
  override readonly name = "CanopyError";
  readonly statusCode: number;
  readonly code: string | null;
  readonly details: string[] | undefined;
  readonly data: unknown;
  /** The path and method that failed, for logging. */
  readonly request: { method: string; path: string };
  /**
   * How long to wait before retrying, in milliseconds, when the server said so
   * via `Retry-After` — populated on a 429, and on any other response that
   * carries the header. Undefined when the server gave no guidance.
   */
  readonly retryAfterMs: number | undefined;

  constructor(
    body: CanopyErrorBody,
    request: { method: string; path: string },
    retryAfterMs?: number,
  ) {
    super(body.message);

    this.statusCode = body.statusCode;
    this.code = body.code;
    this.details = body.details;
    this.data = body.data;
    this.request = request;
    this.retryAfterMs = retryAfterMs;
  }

  /** A 429. `retryAfterMs` is populated when the server said how long to wait. */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  /** 401 or 403 — the credential is wrong or not permitted here. */
  get isAuthFailure(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

/**
 * The request never produced a response — DNS failure, connection reset, or a
 * timeout.
 *
 * Not this: a caller's own cancellation. Aborting the `signal` passed to a
 * request rejects with that abort (`AbortError`, or whatever `signal.reason`
 * holds) and is never retried, because the caller stopping is an intent rather
 * than a failure to report.
 *
 * Kept separate from `CanopyError` because there is no status code and no
 * server opinion to report: nothing is known about whether the operation
 * happened, which matters for anything non-idempotent.
 */
export class CanopyConnectionError extends Error {
  override readonly name = "CanopyConnectionError";
  readonly request: { method: string; path: string };

  constructor(
    message: string,
    request: { method: string; path: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);

    this.request = request;
  }
}

/** Narrowing helper that survives bundling and duplicate copies of the package. */
export function isCanopyError(error: unknown): error is CanopyError {
  return error instanceof Error && error.name === "CanopyError";
}

export function isCanopyConnectionError(
  error: unknown,
): error is CanopyConnectionError {
  return error instanceof Error && error.name === "CanopyConnectionError";
}
