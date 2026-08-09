import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCanopyTokenError } from "./errors.js";
import { type CanopyTokenClaims, TokenVerifier } from "./verify.js";

/**
 * These tests are mostly about tokens that must be REFUSED.
 *
 * A verifier that accepts a genuine token is easy; every hand-rolled one does
 * that on the first try. The value is in the rest — a forged signature, a
 * swapped algorithm, an expired window, an audience meant for someone else —
 * because those are the cases a caller never sees until someone goes looking
 * for them.
 *
 * Keys are generated here rather than fetched, so a wrong-key case is a real
 * wrong key rather than a mocked assertion about one.
 */

const ISSUER = "https://auth.test.example";

interface Signer {
  kid: string;
  jwk: Record<string, unknown>;
  sign: (
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ) => Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const exported = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as Record<string, unknown>;

  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  return {
    kid,
    jwk: { ...exported, kid, alg: "RS256", use: "sig" },
    async sign(claims, header) {
      const head = encode({ alg: "RS256", typ: "JWT", kid, ...header });
      const body = encode(claims);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );

      const bytes = new Uint8Array(signature);
      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      const encodedSignature = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      return `${head}.${body}.${encodedSignature}`;
    },
  };
}

/** A JWKS document as the issuer would serve it. */
function jwksResponse(signers: Signer[]): Response {
  return new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jwksFetch(signers: Signer[]): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
} {
  let calls = 0;

  const fetch = vi.fn(() => {
    calls += 1;

    return Promise.resolve(jwksResponse(signers));
  });

  return { fetch: fetch, calls: () => calls };
}

const now = (): number => Math.floor(Date.now() / 1000);

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "idn_123",
    type: "identity",
    iss: ISSUER,
    exp: now() + 900,
    iat: now(),
    environment_id: "env_1",
    ...overrides,
  };
}

let signer: Signer;

beforeEach(async () => {
  signer = await makeSigner("key-1");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenVerifier — accepting a genuine token", () => {
  it("returns the claims", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    const claims = await verifier.verify(await signer.sign(validClaims()));

    expect(claims.sub).toBe("idn_123");
    expect(claims.type).toBe("identity");
    expect(claims.environment_id).toBe("env_1");
  });

  it("fetches the key set once across many verifications", async () => {
    const { fetch, calls } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await verifier.verify(await signer.sign(validClaims()));
    await verifier.verify(await signer.sign(validClaims()));
    await verifier.verify(await signer.sign(validClaims()));

    // The point of local verification: one network call, then none.
    expect(calls()).toBe(1);
  });

  it("collapses a concurrent burst into a single fetch", async () => {
    const { fetch, calls } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(validClaims());

    await Promise.all([
      verifier.verify(token),
      verifier.verify(token),
      verifier.verify(token),
    ]);

    expect(calls()).toBe(1);
  });
});

describe("TokenVerifier — refusing what it should", () => {
  async function expectCode(
    promise: Promise<CanopyTokenClaims>,
    code: string,
  ): Promise<void> {
    await expect(promise).rejects.toSatisfy(
      (error: unknown) => isCanopyTokenError(error) && error.code === code,
    );
  }

  it("refuses a token signed by a different key", async () => {
    const impostor = await makeSigner("key-1");
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    // Same kid, different private key — the case a kid-only check would pass.
    await expectCode(
      verifier.verify(await impostor.sign(validClaims())),
      "token.signature_invalid",
    );
  });

  it("refuses a tampered payload", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(validClaims());
    const [head, , signature] = token.split(".") as [string, string, string];
    const forged = btoa(JSON.stringify(validClaims({ sub: "idn_admin" })))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expectCode(
      verifier.verify(`${head}.${forged}.${signature}`),
      "token.signature_invalid",
    );
  });

  /**
   * `alg: none` and HMAC key-confusion both work by getting the verifier to
   * take the algorithm from the token. RS256 is pinned, so the header is not
   * consulted for that decision.
   */
  it.each(["none", "HS256", "RS512"])("refuses alg %s", async (alg) => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(validClaims(), { alg });

    await expectCode(verifier.verify(token), "token.unsupported_algorithm");
  });

  it("refuses an expired token", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(validClaims({ exp: now() - 3600 }));

    await expectCode(verifier.verify(token), "token.expired");
  });

  it("allows clock drift within the tolerance but not beyond it", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({
      issuer: ISSUER,
      clockToleranceSec: 60,
      fetch,
    });

    await expect(
      verifier.verify(await signer.sign(validClaims({ exp: now() - 30 }))),
    ).resolves.toBeDefined();

    await expectCode(
      verifier.verify(await signer.sign(validClaims({ exp: now() - 120 }))),
      "token.expired",
    );
  });

  it("refuses a token from another issuer", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(
      validClaims({ iss: "https://auth.someone-else.example" }),
    );

    await expectCode(verifier.verify(token), "token.issuer_mismatch");
  });

  it("refuses a token whose kid matches no published key", async () => {
    const other = await makeSigner("key-2");
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await expectCode(
      verifier.verify(await other.sign(validClaims())),
      "token.key_not_found",
    );
  });

  it.each([
    ["not a jwt", "token.malformed"],
    ["a.b", "token.malformed"],
    ["!!!.!!!.!!!", "token.malformed"],
  ])("refuses malformed input %s", async (token, code) => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await expectCode(verifier.verify(token), code);
  });

  it("surfaces an unreachable key set as its own code", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await expectCode(
      verifier.verify(await signer.sign(validClaims())),
      "token.jwks_unavailable",
    );
  });
});

describe("TokenVerifier — audience", () => {
  it("accepts a Direct API token, which carries no audience", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await expect(
      verifier.verify(await signer.sign(validClaims())),
    ).resolves.toBeDefined();
  });

  it("accepts a Hosted Login token when the audience matches", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({
      issuer: ISSUER,
      audience: "client_abc",
      fetch,
    });

    await expect(
      verifier.verify(await signer.sign(validClaims({ aud: "client_abc" }))),
    ).resolves.toBeDefined();
  });

  it("refuses a token minted for a different client", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({
      issuer: ISSUER,
      audience: "client_abc",
      fetch,
    });

    await expect(
      verifier.verify(await signer.sign(validClaims({ aud: "client_xyz" }))),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isCanopyTokenError(e) && e.code === "token.audience_mismatch",
    );
  });

  /**
   * The quiet one. A token carries `aud` and the verifier was never told which
   * client it is — ignoring the claim would accept a token minted for someone
   * else, so it refuses and names the option instead.
   */
  it("refuses to ignore an audience it was not configured to check", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    await expect(
      verifier.verify(await signer.sign(validClaims({ aud: "client_abc" }))),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isCanopyTokenError(e) && e.code === "token.audience_unverified",
    );
  });
});

describe("TokenVerifier — pre-auth tokens", () => {
  /**
   * A pre-auth token is genuine and correctly signed: every signature check
   * passes. It means "password proved, Account not yet chosen", so treating it
   * as a session is a privilege escalation — and it is exactly what a
   * hand-rolled verifier accepts without noticing.
   */
  it("refuses one by default", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });
    const token = await signer.sign(
      validClaims({ token_type: "preauth", environment_id: undefined }),
    );

    await expect(verifier.verify(token)).rejects.toSatisfy(
      (e: unknown) =>
        isCanopyTokenError(e) && e.code === "token.preauth_not_allowed",
    );
  });

  it("accepts one when the caller opts in, for an account picker", async () => {
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({
      issuer: ISSUER,
      allowPreAuthTokens: true,
      fetch,
    });

    const claims = await verifier.verify(
      await signer.sign(validClaims({ token_type: "preauth" })),
    );

    expect(claims.token_type).toBe("preauth");
  });
});

describe("TokenVerifier — key rotation", () => {
  it("refetches once for an unknown kid, so a rotation is picked up", async () => {
    const rotated = await makeSigner("key-2");
    let published = [signer];
    let calls = 0;

    const fetch = vi.fn(() => {
      calls += 1;

      return Promise.resolve(jwksResponse(published));
    }) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({
      issuer: ISSUER,
      jwksMinRefetchIntervalMs: 0,
      fetch,
    });

    await verifier.verify(await signer.sign(validClaims()));
    expect(calls).toBe(1);

    published = [signer, rotated];

    await expect(
      verifier.verify(await rotated.sign(validClaims())),
    ).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  /**
   * The other half of rotation support: a forged `kid` must not turn every
   * request into a fetch at the issuer.
   */
  it("does not refetch per request for an unknown kid", async () => {
    const unknown = await makeSigner("key-forged");
    let calls = 0;

    const fetch = vi.fn(() => {
      calls += 1;

      return Promise.resolve(jwksResponse([signer]));
    }) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({
      issuer: ISSUER,
      jwksMinRefetchIntervalMs: 60_000,
      fetch,
    });

    const forged = await unknown.sign(validClaims());

    for (let i = 0; i < 5; i++) {
      await expect(verifier.verify(forged)).rejects.toThrow();
    }

    // One priming fetch plus at most one miss-triggered refetch — not five.
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe("TokenVerifier — when the key set cannot be loaded", () => {
  /**
   * The amplifier. An issuer that is down leaves `keys` empty, and without a
   * floor on this path every inbound request takes it and issues its own
   * outbound fetch — one amplified request per caller, on an unauthenticated
   * path, aimed at an issuer that is already unwell.
   */
  it("does not fetch once per request while the issuer is down", async () => {
    let calls = 0;

    const fetch = vi.fn(() => {
      calls += 1;

      return Promise.reject(new TypeError("connection refused"));
    }) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({
      issuer: ISSUER,
      jwksMinRefetchIntervalMs: 60_000,
      fetch,
    });

    const signer = await makeSigner("key-1");
    const token = await signer.sign(validClaims());

    for (let i = 0; i < 10; i++) {
      await expect(verifier.verify(token)).rejects.toThrow();
    }

    expect(calls).toBe(1);
  });

  it("reports the key set as unavailable rather than the key as missing", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError("connection refused")),
    ) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({
      issuer: ISSUER,
      jwksMinRefetchIntervalMs: 60_000,
      fetch,
    });

    const signer = await makeSigner("key-1");
    const token = await signer.sign(validClaims());

    // First attempt fails on the fetch itself.
    await expect(verifier.verify(token)).rejects.toThrow();

    // The second is inside the backoff. It must not claim the key set was read
    // and lacked this kid — nothing has ever been read.
    const error = await verifier.verify(token).catch((e: unknown) => e);

    expect(isCanopyTokenError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("token.jwks_unavailable");
  });

  /**
   * A hung issuer, as opposed to a refusing one. Without a deadline the read
   * never settles and holds every caller waiting on it.
   */
  it("gives up on a JWKS read that never answers", async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;

    const verifier = new TokenVerifier({
      issuer: ISSUER,
      jwksTimeoutMs: 25,
      fetch,
    });

    const signer = await makeSigner("key-1");
    const token = await signer.sign(validClaims());

    const error = await verifier.verify(token).catch((e: unknown) => e);

    expect(isCanopyTokenError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("token.jwks_unavailable");
  });
});

describe("TokenVerifier — claims the type promises", () => {
  /**
   * `CanopyTokenClaims` declares `sub: string`, but the claims are parsed JSON
   * behind a cast. Anything the interface declares and nobody checks is a
   * promise the type makes and the runtime does not keep — and `sub` is the one
   * a caller trusts most, because it decides who the request is acting as.
   */
  it.each([
    ["no sub at all", { sub: undefined }],
    ["an empty sub", { sub: "" }],
    ["a non-string sub", { sub: 12345 }],
  ])("refuses a signed token with %s", async (_label, overrides) => {
    const signer = await makeSigner("key-1");
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    const token = await signer.sign(validClaims(overrides));

    const error = await verifier.verify(token).catch((e: unknown) => e);

    expect(isCanopyTokenError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("token.malformed");
  });

  it("refuses a signed token whose `type` is not a principal kind", async () => {
    const signer = await makeSigner("key-1");
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    // Narrows to the union at compile time and would flow through a `switch`
    // on `claims.type` as though it were one of the four.
    const token = await signer.sign(validClaims({ type: "superuser" }));

    const error = await verifier.verify(token).catch((e: unknown) => e);

    expect(isCanopyTokenError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("token.malformed");
  });

  it("still accepts each of the four principal kinds", async () => {
    const signer = await makeSigner("key-1");
    const { fetch } = jwksFetch([signer]);
    const verifier = new TokenVerifier({ issuer: ISSUER, fetch });

    for (const type of ["user", "identity", "api_key", "platform"]) {
      const token = await signer.sign(validClaims({ type }));

      expect((await verifier.verify(token)).type).toBe(type);
    }
  });
});
