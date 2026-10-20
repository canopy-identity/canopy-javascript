import {
  isCanopyAuthorizerError,
  isCanopyError,
  isCanopyTokenError,
} from "./errors.js";

/**
 * The HTTP answer a failure should become, for code that verifies tokens or
 * authorizes requests outside the NestJS guards (Express, Fastify, a worker).
 * The guards use the same mapping, so every integration answers alike.
 */
export interface FailureStatus {
  status: number;
  /** A message safe to send to the caller; the detail stays on the error. */
  message: string;
}

/**
 * The answer for a failed {@link TokenVerifier.verify}: `401` when the token is
 * at fault, `503` when the signing keys could not be read and the token may be
 * perfectly good.
 *
 * The difference matters. A client reads `401` as "your token is stale",
 * discards a valid one and asks for another, which aims a refresh storm at an
 * issuer that is already down, and an outage that only emits 4xx is invisible
 * to anything watching for 5xx.
 *
 * Anything that is not a token error is returned as `500`: it is a bug, not a
 * verdict on the token.
 */
export function tokenErrorStatus(error: unknown): FailureStatus {
  if (!isCanopyTokenError(error)) {
    return { status: 500, message: "Authentication could not be checked." };
  }

  if (error.code === "token.jwks_unavailable") {
    return {
      status: 503,
      message: "Authentication is temporarily unavailable.",
    };
  }

  return { status: 401, message: "Invalid or expired access token." };
}

/**
 * The answer for a failed authorization check ({@link LocalAuthorizer.evaluate}
 * or a {@link Canopy} call that decides access). Every branch denies; they say
 * different things so an incident is diagnosable:
 *
 * - `500` when the authorizer cannot see far enough to decide (a credential
 *   that cannot read the hierarchy), when Canopy rejected our own credential,
 *   when the endpoint is not served (an SDK newer than the API), or on a 4xx
 *   nobody anticipated. No retry fixes these.
 * - `503` when Canopy did not answer, or answered 429 or 5xx.
 * - `403` when Canopy answered that the identity is not in this Environment.
 */
export function authorizationErrorStatus(error: unknown): FailureStatus {
  if (isCanopyAuthorizerError(error)) {
    return {
      status: 500,
      message: `Authorization is misconfigured: ${error.message}`,
    };
  }

  if (!isCanopyError(error)) {
    return {
      status: 503,
      message: "Authorization is temporarily unavailable.",
    };
  }

  if (error.isAuthFailure) {
    return {
      status: 500,
      message:
        "Authorization is misconfigured. Check the Canopy API key and its scopes.",
    };
  }

  // A 404 with no error code is the framework's own "no such route": this
  // Canopy does not serve the endpoint the authorizer reads.
  if (error.statusCode === 404 && error.code === null) {
    return {
      status: 500,
      message:
        `Authorization is misconfigured: ${error.request.method} ${error.request.path} is not served by this Canopy. ` +
        "The SDK requires an API that exposes the identity grants endpoint.",
    };
  }

  // A 404 with a code is a real answer: the identity is not in this
  // Environment. Deny, and say nothing about what was missing.
  if (error.statusCode === 404) {
    return { status: 403, message: "Could not evaluate the permission." };
  }

  if (error.isRateLimited || error.statusCode >= 500) {
    return {
      status: 503,
      message: "Authorization is temporarily unavailable.",
    };
  }

  return { status: 500, message: "Authorization could not be evaluated." };
}
