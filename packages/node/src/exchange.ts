import { CanopyConnectionError, CanopyError } from "./errors.js";
import { hostedOrigin } from "./origin.js";
import { withoutTrailingSlashes } from "./strings.js";

/** The RFC 8693 grant a machine client exchanges a person's token with. */
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";

/** The only token type Canopy exchanges, and the only one it issues. */
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

const TOKEN_PATH = "/oauth/token";

export interface ExchangeTokenOptions {
  /** The machine client's `client_id`. Its token exchange switch must be on. */
  clientId: string;
  /** The machine client's secret. Keep it on the server; never in a browser. */
  clientSecret: string;
  /**
   * The signed-in person's access token, issued by the same Environment. The
   * person must still be signed in and a member, and, for a client pinned to
   * an organization, inside that organization.
   */
  subjectToken: string;
  /**
   * The API the new token is for: the Environment's default audience when
   * omitted, or one in the client's allowed audiences.
   */
  audience?: string;
  /** Space-separated scopes, from the client's own. */
  scope?: string;
  /**
   * The origin that serves the Environment's token endpoint: Canopy's hosted
   * origin (or `CANOPY_BASE_URL`) by default, or your custom auth domain
   * when the Environment has one.
   */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** A delegated token, ready to send as `Authorization: Bearer`. */
export interface ExchangedToken {
  accessToken: string;
  tokenType: "Bearer";
  /** Seconds until it expires: the machine-token lifetime or the person's remaining time, whichever is shorter. */
  expiresIn: number;
  /** The scopes it was granted, space-separated, when any were. */
  scope?: string;
  /** Always `urn:ietf:params:oauth:token-type:access_token`. */
  issuedTokenType: string;
}

/**
 * Exchange a signed-in person's access token for one that lets a machine
 * client act for them (RFC 8693 token exchange).
 *
 * The token that comes back is `delegated`: `sub` is the person, `act.sub`
 * the client, and it reaches only what both hold. It has no refresh token;
 * exchange again when it expires. Canopy's own API refuses it: it is for your
 * API, which verifies it with `alsoAllow: ["delegated"]` and authorizes it
 * with both principals (`acting_client_id`).
 *
 * ```ts
 * const { accessToken } = await exchangeToken({
 *   clientId: process.env.AGENT_CLIENT_ID!,
 *   clientSecret: process.env.AGENT_CLIENT_SECRET!,
 *   subjectToken: personAccessToken,
 *   audience: "https://api.example.com",
 * });
 * ```
 *
 * A refusal throws `CanopyError` with the OAuth error as its code
 * (`oauth.invalid_grant` when the person signed out or is no longer a
 * member, `oauth.unauthorized_client` when the client's token exchange
 * switch is off, `oauth.invalid_request` with `retryAfterMs` when it asked
 * too often). A request that never got an answer throws
 * `CanopyConnectionError`.
 */
export async function exchangeToken(
  options: ExchangeTokenOptions,
): Promise<ExchangedToken> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const origin = withoutTrailingSlashes(options.baseUrl ?? hostedOrigin());
  const request = { method: "POST", path: TOKEN_PATH };
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: options.subjectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
  });

  if (options.audience !== undefined) {
    body.set("audience", options.audience);
  }

  if (options.scope !== undefined) {
    body.set("scope", options.scope);
  }

  const credentials = btoa(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
  );

  let response: Response;

  try {
    response = await fetchImpl(`${origin}${TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }

    throw new CanopyConnectionError(
      `Could not reach ${origin}${TOKEN_PATH}.`,
      request,
      { cause: error },
    );
  }

  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    const error =
      typeof payload?.["error"] === "string" ? payload["error"] : null;
    const description =
      typeof payload?.["error_description"] === "string"
        ? payload["error_description"]
        : `The token endpoint answered ${response.status}.`;
    const retryAfter = Number(response.headers.get("retry-after"));

    throw new CanopyError(
      {
        statusCode: response.status,
        code: error ? `oauth.${error}` : null,
        message: description,
      },
      request,
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : undefined,
    );
  }

  if (
    typeof payload?.["access_token"] !== "string" ||
    typeof payload["expires_in"] !== "number"
  ) {
    throw new CanopyError(
      {
        statusCode: response.status,
        code: null,
        message: "The token endpoint answered without an access token.",
      },
      request,
    );
  }

  return {
    accessToken: payload["access_token"],
    tokenType: "Bearer",
    expiresIn: payload["expires_in"],
    ...(typeof payload["scope"] === "string"
      ? { scope: payload["scope"] }
      : {}),
    issuedTokenType:
      typeof payload["issued_token_type"] === "string"
        ? payload["issued_token_type"]
        : ACCESS_TOKEN_TYPE,
  };
}
