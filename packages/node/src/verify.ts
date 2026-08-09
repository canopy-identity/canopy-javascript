import { CanopyTokenError } from "./errors.js";

/**
 * Local verification of a Canopy access token.
 *
 * Canopy signs access tokens with RS256 and publishes the matching public keys
 * at `/.well-known/jwks.json`, so a token can be checked entirely in-process:
 * fetch the keys once, then every verification after that is a signature check
 * with no network call. This is why authentication does not cost a round trip
 * the way an authorization check does.
 *
 * Verification is the part of an integration that is easiest to get subtly
 * wrong — accepting `alg: none`, trusting `kid` without bounding refetches,
 * skipping `aud` when the token carries one, treating a pre-auth token as a
 * session. Each of those is handled here so a caller does not have to know
 * they exist.
 *
 * ```ts
 * const verifier = new TokenVerifier();
 * const claims = await verifier.verify(token);
 * ```
 *
 * Deliberately standalone rather than a member of {@link Canopy}: that client
 * requires an API key or an access token, and a backend that only checks
 * logins holds neither.
 */

/** Canopy's hosted issuer. Matches the client's default base URL. */
const DEFAULT_ISSUER = "https://auth.canopy-io.com";

/** How long a fetched key set is reused before being refreshed. */
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Floor between JWKS fetches triggered by an unknown `kid`.
 *
 * Key rotation means an unrecognised `kid` is sometimes legitimate, so a miss
 * has to be able to refetch. Left unbounded, that is also a free amplifier: a
 * forged token carrying a random `kid` would make this process call the issuer
 * once per request. The floor keeps rotation working while capping the damage
 * at one fetch per interval.
 */
const DEFAULT_JWKS_MIN_REFETCH_INTERVAL_MS = 30 * 1000;

/**
 * Deadline for one JWKS read.
 *
 * Verification happens on the request path, so an unbounded read here is an
 * unbounded inbound request: an issuer that accepts the connection and then
 * goes quiet would hold every caller that needs a key, indefinitely.
 */
const DEFAULT_JWKS_TIMEOUT_MS = 5_000;

/** The principal kinds a Canopy token may claim to be. */
const PRINCIPAL_TYPES = new Set(["user", "identity", "api_key", "platform"]);

/**
 * Leeway applied to time-based claims, for ordinary clock drift between the
 * issuer and this machine. Seconds, not minutes: a generous window here
 * extends the life of a token that should have expired.
 */
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

export interface TokenVerifierOptions {
  /**
   * The issuer whose tokens are accepted, matched against `iss` exactly.
   * Defaults to Canopy's hosted issuer; set it for a self-hosted instance.
   *
   * Safe to default because it fails closed: pointed at the wrong issuer, a
   * token is rejected rather than accepted.
   */
  issuer?: string;

  /**
   * Required audience, matched against `aud`.
   *
   * Hosted Login (OAuth) tokens carry `aud` — your client id — and Direct API
   * identity tokens do not. Verifying an OAuth token without setting this
   * throws rather than ignoring the claim, because `aud` is what stops a token
   * minted for one client being replayed at another.
   */
  audience?: string;

  /** Where the signing keys live. Defaults to `${issuer}/.well-known/jwks.json`. */
  jwksUri?: string;

  /** How long a fetched key set is reused. Defaults to 10 minutes. */
  jwksCacheMaxAgeMs?: number;

  /** Floor between refetches provoked by an unknown `kid`. Defaults to 30s. */
  jwksMinRefetchIntervalMs?: number;

  /** Leeway on `exp` and `nbf`, in seconds. Defaults to 60. */
  clockToleranceSec?: number;

  /**
   * Accept pre-auth tokens. Defaults to `false`, and should stay false unless
   * you are building an account picker.
   *
   * A pre-auth token is a genuine, correctly-signed Canopy token issued
   * partway through a multi-account login: the person proved their password
   * but has not yet chosen an Account, so the token carries no Account context
   * and grants nothing. Accepting one as a session is a privilege escalation,
   * and it is the failure a hand-rolled verifier is most likely to miss —
   * every signature check passes.
   */
  allowPreAuthTokens?: boolean;

  /**
   * Deadline for a single JWKS read, in milliseconds. Defaults to 5s.
   *
   * Without one, an issuer that accepts a connection and then never answers
   * holds every inbound request that needs a key — the verification sits on the
   * request path, so an unbounded read there is an unbounded request.
   */
  jwksTimeoutMs?: number;

  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The claims Canopy puts in an access token.
 *
 * Named claims are the ones the API guarantees; the index signature keeps
 * anything added later reachable without a version bump.
 */
export interface CanopyTokenClaims {
  /** The identity or user this token acts as. */
  sub: string;
  /** Which kind of principal `sub` is. */
  type: "user" | "identity" | "api_key" | "platform";
  iss: string;
  exp: number;
  iat?: number;
  nbf?: number;
  aud?: string | string[];
  account_id?: string;
  application_id?: string;
  /** Identity tokens carry this; admin tokens deliberately omit it. */
  environment_id?: string;
  account_slug?: string;
  application_slug?: string;
  environment_slug?: string;
  /** Present only on a pre-auth token — see `allowPreAuthTokens`. */
  token_type?: "preauth";
  console_access?: "granted" | "none";
  /** Emitted only when the `permissions` OAuth scope was granted. */
  permissions?: string[];
  /** True when `permissions` was truncated; query the API for the full set. */
  permissions_overflow?: boolean;
  [claim: string]: unknown;
}

interface JwksKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

/** base64url → bytes, without assuming Buffer (this runs in workers too). */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJsonSegment(segment: string, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch (cause) {
    throw new CanopyTokenError(
      "token.malformed",
      `Token ${what} is not valid base64url-encoded JSON.`,
      { cause },
    );
  }
}

export class TokenVerifier {
  private readonly issuer: string;
  private readonly audience: string | undefined;
  private readonly jwksUri: string;
  private readonly jwksCacheMaxAgeMs: number;
  private readonly jwksMinRefetchIntervalMs: number;
  private readonly jwksTimeoutMs: number;
  private readonly clockToleranceSec: number;
  private readonly allowPreAuthTokens: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** Imported keys by `kid`, so a repeat verification skips the import cost. */
  private keys = new Map<string, CryptoKey>();
  private keysFetchedAt = 0;
  private lastFetchAttemptAt = 0;
  /** In-flight fetch, so a burst of requests triggers one call, not N. */
  private inFlight: Promise<void> | null = null;

  constructor(options: TokenVerifierOptions = {}) {
    this.issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
    this.audience = options.audience;
    this.jwksUri = options.jwksUri ?? `${this.issuer}/.well-known/jwks.json`;
    this.jwksCacheMaxAgeMs =
      options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS;
    this.jwksMinRefetchIntervalMs =
      options.jwksMinRefetchIntervalMs ?? DEFAULT_JWKS_MIN_REFETCH_INTERVAL_MS;
    this.jwksTimeoutMs = options.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS;
    this.clockToleranceSec =
      options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
    this.allowPreAuthTokens = options.allowPreAuthTokens ?? false;

    const boundFetch = options.fetch ?? globalThis.fetch;

    if (typeof boundFetch !== "function") {
      throw new TypeError(
        "TokenVerifier requires a fetch implementation. Pass `fetch` on Node runtimes without a global one.",
      );
    }

    this.fetchImpl = boundFetch.bind(globalThis);
  }

  /**
   * Verify a token and return its claims. Throws {@link CanopyTokenError} on
   * anything short of a full pass — branch on `error.code`.
   *
   * Order matters: the signature is checked before any claim is believed, so
   * nothing downstream ever reads an unverified payload.
   */
  async verify(token: string): Promise<CanopyTokenClaims> {
    const parts = token.split(".");

    if (parts.length !== 3) {
      throw new CanopyTokenError(
        "token.malformed",
        "Token is not a three-part JWS.",
      );
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];

    const header = decodeJsonSegment(encodedHeader, "header") as JwtHeader;

    // Pinned, not merely checked: accepting whatever `alg` the token names is
    // how `none` and HMAC-key-confusion attacks get in.
    if (header.alg !== "RS256") {
      throw new CanopyTokenError(
        "token.unsupported_algorithm",
        `Token is signed with "${header.alg ?? "none"}"; Canopy issues RS256.`,
      );
    }

    const key = await this.resolveKey(header.kid);
    const signed = new TextEncoder().encode(
      `${encodedHeader}.${encodedPayload}`,
    );

    let signatureValid: boolean;

    try {
      signatureValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decodeBase64Url(encodedSignature),
        signed,
      );
    } catch (cause) {
      throw new CanopyTokenError(
        "token.malformed",
        "Token signature is not decodable.",
        { cause },
      );
    }

    if (!signatureValid) {
      throw new CanopyTokenError(
        "token.signature_invalid",
        "Token signature does not match Canopy's signing key.",
      );
    }

    const claims = decodeJsonSegment(
      encodedPayload,
      "payload",
    ) as CanopyTokenClaims;

    this.assertClaims(claims);

    return claims;
  }

  /** Everything checked after the signature is known good. */
  private assertClaims(claims: CanopyTokenClaims): void {
    // Checked, not assumed. The claims arrive as parsed JSON and are cast to
    // this interface, so anything the interface declares but nobody verifies is
    // a promise the type makes and the runtime does not keep. `sub` is the
    // whole point of a verified token — a caller reads it to decide who is
    // acting — and a `string` that is actually `undefined` is worse than a
    // rejected token, because it looks like an answer.
    if (typeof claims.sub !== "string" || claims.sub === "") {
      throw new CanopyTokenError(
        "token.malformed",
        "Token has no `sub` claim, so it identifies no one.",
      );
    }

    // Same reasoning. `type` narrows to four values, and code branches on it;
    // a fifth would flow through a `switch` as though it were one of them.
    if (!PRINCIPAL_TYPES.has(claims.type)) {
      throw new CanopyTokenError(
        "token.malformed",
        `Token has an unrecognised \`type\` claim: ${JSON.stringify(claims.type)}.`,
      );
    }

    if (claims.iss !== this.issuer) {
      throw new CanopyTokenError(
        "token.issuer_mismatch",
        `Token was issued by "${String(claims.iss)}", not "${this.issuer}".`,
      );
    }

    const now = Math.floor(Date.now() / 1000);

    if (typeof claims.exp !== "number") {
      throw new CanopyTokenError(
        "token.malformed",
        "Token has no `exp` claim.",
      );
    }

    if (now > claims.exp + this.clockToleranceSec) {
      throw new CanopyTokenError("token.expired", "Token has expired.");
    }

    if (
      typeof claims.nbf === "number" &&
      now < claims.nbf - this.clockToleranceSec
    ) {
      throw new CanopyTokenError(
        "token.not_yet_valid",
        "Token is not valid yet.",
      );
    }

    this.assertAudience(claims);

    if (claims.token_type === "preauth" && !this.allowPreAuthTokens) {
      throw new CanopyTokenError(
        "token.preauth_not_allowed",
        "This is a pre-auth token: the user authenticated but has not selected an Account, so it grants no access. " +
          "Set `allowPreAuthTokens: true` only if you are building the account picker.",
      );
    }
  }

  /**
   * `aud` is checked when either side mentions it.
   *
   * The case worth stating: a token carries `aud` but the verifier was not
   * configured with one. That is not "no audience to check" — it is an OAuth
   * token being verified by something that never said which client it is, and
   * ignoring it would accept a token minted for a different client. So it
   * throws and names the option.
   */
  private assertAudience(claims: CanopyTokenClaims): void {
    const audiences =
      claims.aud === undefined
        ? []
        : Array.isArray(claims.aud)
          ? claims.aud
          : [claims.aud];

    if (this.audience === undefined) {
      if (audiences.length > 0) {
        throw new CanopyTokenError(
          "token.audience_unverified",
          "Token carries an `aud` claim but the verifier has no `audience` configured. " +
            "Set `audience` to your OAuth client id; Direct API tokens carry no audience and need no option.",
        );
      }

      return;
    }

    if (!audiences.includes(this.audience)) {
      throw new CanopyTokenError(
        "token.audience_mismatch",
        `Token audience does not include "${this.audience}".`,
      );
    }
  }

  /**
   * The signing key for a `kid`, fetching the key set when it is stale or when
   * the `kid` is unknown — the latter is how key rotation is picked up
   * mid-process, bounded by `jwksMinRefetchIntervalMs`.
   */
  private async resolveKey(kid: string | undefined): Promise<CryptoKey> {
    if (kid === undefined) {
      throw new CanopyTokenError(
        "token.malformed",
        "Token header has no `kid`, so its signing key cannot be identified.",
      );
    }

    const stale = Date.now() - this.keysFetchedAt > this.jwksCacheMaxAgeMs;

    if (this.keys.size === 0 || stale) {
      // Floored like the rotation branch below, and for the same reason. With
      // no floor here, a key set that cannot be loaded — issuer down, or the
      // very first fetch failed — leaves `keys` empty, and every inbound
      // request takes this branch and issues its own outbound fetch. That is
      // one amplified request per caller, on an unauthenticated path, aimed at
      // the issuer precisely while it is already unwell.
      //
      // `lastFetchAttemptAt` starts at 0, so a genuine cold start is never
      // delayed by this — only a retry after a recent attempt is.
      if (this.shouldRefresh()) {
        await this.refreshKeys();
      } else if (this.keys.size === 0) {
        // Backing off with nothing cached: say so, rather than falling through
        // to `key_not_found`, which would claim the key set was read and
        // lacked this `kid`.
        throw new CanopyTokenError(
          "token.jwks_unavailable",
          `Signing keys at ${this.jwksUri} are unavailable; backing off before retrying.`,
        );
      }
    }

    const cached = this.keys.get(kid);

    if (cached) {
      return cached;
    }

    // Unknown kid: possibly a rotation, possibly a forged header. Refetch at
    // most once per interval so the second case cannot amplify.
    if (this.shouldRefresh()) {
      await this.refreshKeys();
    }

    const rotated = this.keys.get(kid);

    if (rotated) {
      return rotated;
    }

    throw new CanopyTokenError(
      "token.key_not_found",
      `No signing key matches kid "${kid}".`,
    );
  }

  /**
   * Whether to await a key-set refresh.
   *
   * Two ways to qualify, and the first matters as much as the second. A read
   * already in flight is joined regardless of the floor: it costs no extra
   * outbound request, and it is what lets a concurrent burst share one fetch
   * instead of one caller winning and the rest being turned away.
   *
   * Otherwise the floor applies — the same one for every refetch path, so they
   * cannot drift into having different amplification properties.
   */
  private shouldRefresh(): boolean {
    if (this.inFlight) {
      return true;
    }

    return (
      Date.now() - this.lastFetchAttemptAt >= this.jwksMinRefetchIntervalMs
    );
  }

  private async refreshKeys(): Promise<void> {
    // Collapse a burst: concurrent requests await one fetch rather than each
    // issuing their own.
    this.inFlight ??= this.fetchKeys().finally(() => {
      this.inFlight = null;
    });

    await this.inFlight;
  }

  private async fetchKeys(): Promise<void> {
    this.lastFetchAttemptAt = Date.now();

    let response: Response;

    // Bounded: an issuer that accepts the connection and then never answers
    // would otherwise hold this request, and every request waiting on the same
    // in-flight read, for as long as it stays quiet.
    const controller = new AbortController();
    const timer =
      this.jwksTimeoutMs > 0
        ? setTimeout(() => controller.abort(), this.jwksTimeoutMs)
        : undefined;

    try {
      response = await this.fetchImpl(this.jwksUri, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new CanopyTokenError(
        "token.jwks_unavailable",
        `Could not reach the signing keys at ${this.jwksUri}.`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new CanopyTokenError(
        "token.jwks_unavailable",
        `Signing keys at ${this.jwksUri} returned HTTP ${response.status}.`,
      );
    }

    let document: { keys?: JwksKey[] };

    try {
      document = (await response.json()) as { keys?: JwksKey[] };
    } catch (cause) {
      throw new CanopyTokenError(
        "token.jwks_unavailable",
        `Signing keys at ${this.jwksUri} were not valid JSON.`,
        { cause },
      );
    }

    const imported = new Map<string, CryptoKey>();

    for (const jwk of document.keys ?? []) {
      if (
        jwk.kty !== "RSA" ||
        jwk.kid === undefined ||
        jwk.n === undefined ||
        jwk.e === undefined
      ) {
        continue;
      }

      if (jwk.alg !== undefined && jwk.alg !== "RS256") {
        continue;
      }

      try {
        imported.set(
          jwk.kid,
          await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        );
      } catch {
        // One unusable key must not blind the verifier to the others.
        continue;
      }
    }

    if (imported.size === 0) {
      throw new CanopyTokenError(
        "token.jwks_unavailable",
        `Signing keys at ${this.jwksUri} contained no usable RS256 key.`,
      );
    }

    this.keys = imported;
    this.keysFetchedAt = Date.now();
  }
}
