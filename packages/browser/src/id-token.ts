import { CanopyAuthError } from "./errors.js";
import { base64UrlDecode } from "./pkce.js";

/**
 * The claims of a Canopy ID token. Present claims depend on the scopes asked
 * for. The Environment's custom claims marked for the ID token arrive through
 * the index signature; name them to `getClaims<TCustom>()` to read them typed.
 */
export interface IdTokenClaims {
  /** The identity's id: the stable user identifier. */
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  /**
   * How the sign-in was proven: `pwd`, `otp`, `sso`, `hwk` for a passkey,
   * plus `mfa` once a second factor was verified.
   */
  amr?: string[];
  /** With the `email` scope. */
  email?: string;
  email_verified?: boolean;
  /** With the `profile` scope. */
  name?: string;
  given_name?: string;
  family_name?: string;
  /** With the `org` scope. */
  account_id?: string;
  application_id?: string;
  environment_id?: string;
  /** When the Environment's organizations are on and the person belongs to one. */
  org_id?: string;
  org_roles?: string[];
  org_role_ids?: string[];
  /** `"all"` for the developer's own staff, who may enter any organization. */
  org_scope?: "all";
  /**
   * True when the Environment's custom claims did not all fit on this token;
   * a missing one is then unknown rather than unset.
   */
  custom_claims_overflow?: boolean;
  [claim: string]: unknown;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];

  if (!payload) {
    throw new CanopyAuthError("invalid_token", "The token is not a JWT.");
  }

  const parsed: unknown = JSON.parse(base64UrlDecode(payload));

  if (typeof parsed !== "object" || parsed === null) {
    throw new CanopyAuthError("invalid_token", "The token has no claims.");
  }

  return parsed as Record<string, unknown>;
}

/**
 * Check an ID token received straight from the token endpoint.
 *
 * The signature is not checked here: OpenID Connect Core 3.1.3.7 lets a
 * client skip it for a token it received directly from the token endpoint
 * over TLS, which is the only way this package receives one. Everything that
 * ties the token to this sign-in is checked: the issuer, the audience, the
 * nonce this sign-in sent, and that it has not expired. A backend verifying a
 * token it was handed verifies the signature too (`@canopy-io/node`).
 */
export function checkIdToken(
  token: string,
  expected: { issuer: string; clientId: string; nonce: string | undefined },
  nowSeconds: number,
): IdTokenClaims {
  const claims = decodeJwtPayload(token);
  const audience = claims["aud"];
  const audiences = Array.isArray(audience) ? audience : [audience];

  if (claims["iss"] !== expected.issuer) {
    throw new CanopyAuthError(
      "invalid_token",
      `The ID token's issuer is ${String(claims["iss"])}, not ${expected.issuer}.`,
    );
  }

  if (!audiences.includes(expected.clientId)) {
    throw new CanopyAuthError(
      "invalid_token",
      "The ID token was not issued to this client.",
    );
  }

  if (expected.nonce !== undefined && claims["nonce"] !== expected.nonce) {
    throw new CanopyAuthError(
      "invalid_token",
      "The ID token answers another sign-in: its nonce does not match.",
    );
  }

  if (typeof claims["exp"] !== "number" || claims["exp"] <= nowSeconds) {
    throw new CanopyAuthError("invalid_token", "The ID token has expired.");
  }

  return claims as IdTokenClaims;
}
