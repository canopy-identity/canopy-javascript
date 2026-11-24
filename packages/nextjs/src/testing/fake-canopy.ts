/**
 * A stand-in for Canopy, answering every request the package makes through a
 * replaced `fetch`: discovery, the signing keys, the token and revocation
 * endpoints, an identity's grants and the hierarchy. Tokens are really
 * signed, so `auth()` verifies them exactly as it would in production. Every
 * request is recorded, so a test can say how many reached Canopy.
 */

export const BASE = "https://canopy.test";
export const ISSUER = `${BASE}/environments/env_1`;
export const CLIENT_ID = "client_1";
export const APP_URL = "https://app.example.com";

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: URLSearchParams | null;
}

interface Signer {
  jwk: Record<string, unknown>;
  sign(claims: Record<string, unknown>): Promise<string>;
}

async function makeSigner(): Promise<Signer> {
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

  return {
    jwk: { ...exported, kid: "key_1", alg: "RS256", use: "sig" },
    async sign(claims) {
      const head = encode({ alg: "RS256", typ: "JWT", kid: "key_1" });
      const body = encode(claims);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );

      return `${head}.${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
    },
  };
}

function encode(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function meta(itemCount: number) {
  return {
    page: 1,
    take: 100,
    item_count: itemCount,
    page_count: 1,
    has_previous_page: false,
    has_next_page: false,
  };
}

/** root ─ engineering ─ frontend, and root ─ sales. */
const EDGES = [
  { id: "root", parent_node_id: null },
  { id: "engineering", parent_node_id: "root" },
  { id: "frontend", parent_node_id: "engineering" },
  { id: "sales", parent_node_id: "root" },
];

export interface FakeCanopy {
  requests: Recorded[];
  /** Requests other than the signing keys, which verification reads once. */
  callsToCanopy(): Recorded[];
  fetch: typeof fetch;
  accessToken(overrides?: Record<string, unknown>): Promise<string>;
  idToken(nonce: string): Promise<string>;
  /** The nonce the next ID token carries: the one the sign-in sent. */
  nonce: string;
  /** What the next token request answers; a function sees the request. */
  tokenAnswer: (body: URLSearchParams) => Promise<Response>;
  refreshTokens: string[];
}

export async function fakeCanopy(): Promise<FakeCanopy> {
  const signer = await makeSigner();
  const requests: Recorded[] = [];
  let issued = 0;

  const accessToken = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);

    return signer.sign({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "identity_1",
      type: "identity",
      environment_id: "env_1",
      iat: now,
      exp: now + 900,
      ...overrides,
    });
  };

  const fake: FakeCanopy = {
    requests,
    callsToCanopy: () =>
      requests.filter((r) => !r.url.pathname.endsWith("/jwks.json")),
    accessToken,
    idToken: (nonce) =>
      signer.sign({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: "identity_1",
        nonce,
        name: "Maya Chen",
        email: "maya@acme.io",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    refreshTokens: [],
    nonce: "",
    tokenAnswer: async (body) => {
      issued += 1;

      const refreshToken = `rt_${issued}`;

      fake.refreshTokens.push(refreshToken);

      return json({
        access_token: await accessToken(),
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 900,
        ...(body.get("grant_type") === "authorization_code"
          ? { id_token: await fake.idToken(fake.nonce) }
          : {}),
      });
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : typeof init?.body === "string"
            ? new URLSearchParams(init.body)
            : null;

      requests.push({
        method:
          (input instanceof Request ? input.method : init?.method) ?? "GET",
        url,
        headers,
        body,
      });

      switch (url.pathname) {
        case "/environments/env_1/.well-known/openid-configuration":
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${BASE}/oauth/authorize`,
            token_endpoint: `${BASE}/oauth/token`,
            revocation_endpoint: `${BASE}/oauth/revoke`,
            end_session_endpoint: `${BASE}/auth/logout`,
          });
        case "/environments/env_1/.well-known/jwks.json":
          return json({ keys: [signer.jwk] });
        case "/oauth/token":
          return fake.tokenAnswer(body ?? new URLSearchParams());
        case "/oauth/revoke":
          return new Response(null, { status: 200 });
        case "/api/v1/identities/identity_1/grants":
          return conditional(headers, 'W/"grants-1"', {
            model_version: 1,
            items: [{ permission: "deals.update", node_id: "engineering" }],
            denies: [],
            pagination: meta(1),
          });
        case "/api/v1/nodes/parents":
          return conditional(headers, 'W/"tree-1"', {
            model_version: 1,
            items: EDGES,
            pagination: meta(EDGES.length),
          });
        default:
          return json({ error: "not_found" }, 404);
      }
    },
  };

  return fake;
}

function conditional(headers: Headers, etag: string, body: unknown): Response {
  if (headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return json(body, 200, { etag });
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
