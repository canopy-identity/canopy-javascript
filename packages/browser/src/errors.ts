/**
 * Everything this package throws or hands back.
 *
 * Two classes, because an app acts on the distinction: `CanopyAuthError`
 * means Canopy answered and said no (an OAuth error from the redirect or the
 * token endpoint), and `CanopyConnectionError` means no answer could be read
 * at all, which in a browser is most often the page's origin missing from the
 * Environment's allowed web origins.
 */

/**
 * The OAuth error codes that mean "send the person through sign-in": the
 * answers to `prompt=none` when there is no session to resume, or the sign-in
 * needs the person (a second factor, an enrolment, a policy).
 */
const NEEDS_SIGN_IN = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
]);

/** Canopy answered with an OAuth error. Branch on `code`, never `message`. */
export class CanopyAuthError extends Error {
  override readonly name = "CanopyAuthError";
  /** The OAuth `error`, e.g. `login_required` or `invalid_grant`. */
  readonly code: string;
  /** The `error_description`, for logging. Not meant for end users. */
  readonly description: string | undefined;
  /** The HTTP status, when the error came from an endpoint rather than the redirect. */
  readonly status: number | undefined;

  constructor(code: string, description?: string, status?: number) {
    super(description ? `${code}: ${description}` : code);

    this.code = code;
    this.description = description;
    this.status = status;
  }

  /**
   * True when the answer means the person has to sign in: a silent attempt
   * found no session, or the session needs them for something. Show your
   * sign-in button rather than trying again silently.
   */
  get needsSignIn(): boolean {
    return NEEDS_SIGN_IN.has(this.code);
  }
}

/**
 * No response could be read from Canopy.
 *
 * A browser reports a response its cross-origin policy refuses exactly as it
 * reports a network failure, so this covers both. The message names the
 * likelier cause for a page that has never worked: its origin is not on the
 * Environment's allowed web origins.
 */
export class CanopyConnectionError extends Error {
  override readonly name = "CanopyConnectionError";
  /** The URL that could not be read. */
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Could not read a response from ${url}. If this page has never signed ` +
        `in, add its origin (${currentOrigin()}) to the Environment's ` +
        `Allowed web origins in the Developer Console; the browser blocks ` +
        `the response otherwise.`,
      { cause },
    );

    this.url = url;
  }
}

function currentOrigin(): string {
  return typeof location === "undefined" ? "this origin" : location.origin;
}

export function isCanopyAuthError(error: unknown): error is CanopyAuthError {
  return error instanceof CanopyAuthError;
}

export function isCanopyConnectionError(
  error: unknown,
): error is CanopyConnectionError {
  return error instanceof CanopyConnectionError;
}
