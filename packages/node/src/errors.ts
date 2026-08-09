/**
 * Everything this client throws.
 *
 * Three classes, because callers act on the distinction: `CanopyError` means
 * the API answered and said no, `CanopyConnectionError` means it never
 * answered, and `CanopyTokenError` means a token failed local verification
 * without anything being asked of the API at all. The first is a decision you
 * may need to surface to a user; the second is usually worth retrying or
 * alerting on; the third is a 401 for the caller who presented the token.
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

/**
 * A token failed verification.
 *
 * Separate from `CanopyError` because nothing was asked of the API: the token
 * was checked here, against keys already held. There is no status code to
 * report and no server opinion to relay — the decision was local, which is the
 * whole point of verifying a signature rather than calling an endpoint.
 *
 * Branch on `code`; it follows the same dot-notation contract as the API's own
 * codes. Every one of them means the same thing to an HTTP caller — 401 — so
 * the code is for your logs and your tests, not usually for the response.
 */
export class CanopyTokenError extends Error {
  override readonly name = "CanopyTokenError";

  /**
   * One of:
   *
   * - `token.malformed` — not a JWS, or a segment would not decode
   * - `token.unsupported_algorithm` — not RS256; Canopy issues only RS256
   * - `token.key_not_found` — no published key matches the token's `kid`
   * - `token.jwks_unavailable` — the key set could not be fetched or parsed
   * - `token.signature_invalid` — signature does not match the signing key
   * - `token.expired` / `token.not_yet_valid` — outside its validity window
   * - `token.issuer_mismatch` — `iss` is not the configured issuer
   * - `token.audience_mismatch` — `aud` does not include the configured audience
   * - `token.audience_unverified` — token has an `aud` but none was configured
   * - `token.preauth_not_allowed` — a pre-auth token, which grants no access
   */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);

    this.code = code;
  }
}

/**
 * The local authorizer could not answer, and must not pretend otherwise.
 *
 * Distinct from a denial. It is raised when the data a decision needs is not
 * merely absent but *unreadable* — most often a credential that cannot read the
 * hierarchy, which comes back as an empty tree rather than an error. Denying
 * there would be a silent, total false-deny on every node-scoped route while
 * every response still looked healthy.
 *
 * No retry fixes it, so callers should treat it as a misconfiguration rather
 * than an outage.
 */
export class CanopyAuthorizerError extends Error {
  override readonly name = "CanopyAuthorizerError";
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);

    this.code = code;
  }
}

export function isCanopyAuthorizerError(
  error: unknown,
): error is CanopyAuthorizerError {
  return error instanceof Error && error.name === "CanopyAuthorizerError";
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

export function isCanopyTokenError(error: unknown): error is CanopyTokenError {
  return error instanceof Error && error.name === "CanopyTokenError";
}
