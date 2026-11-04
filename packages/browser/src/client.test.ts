import { describe, expect, it, vi } from "vitest";

import {
  createCanopyBrowserClient,
  type CanopyBrowserClientOptions,
} from "./client.js";
import { type CanopyAuthError, CanopyConnectionError } from "./errors.js";

const ISSUER = "https://auth.test/environments/env-1";
const CLIENT_ID = "client-1";
const REDIRECT_URI = "https://app.test/callback";
const NOW = 1_800_000_000_000;

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: "https://auth.test/oauth/authorize",
  token_endpoint: "https://auth.test/oauth/token",
  revocation_endpoint: "https://auth.test/oauth/revoke",
  end_session_endpoint: "https://auth.test/auth/logout",
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(claims: Record<string, unknown> = {}): string {
  return [
    encode({ alg: "RS256", kid: "k1" }),
    encode({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "identity-1",
      iat: NOW / 1000,
      exp: NOW / 1000 + 900,
      email: "ada@example.test",
      ...claims,
    }),
    "signature",
  ].join(".");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MemoryStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

interface Call {
  url: string;
  body: URLSearchParams | undefined;
}

/**
 * A browser stand-in: answers discovery itself and replays `token` for every
 * POST, recording what was sent. `navigate` records where the page went.
 */
function harness(
  token: (
    body: URLSearchParams,
    nonce: string,
  ) => Response | Promise<Response> = (_body, nonce) =>
    tokens({ id_token: idToken({ nonce }) }),
  overrides: Partial<CanopyBrowserClientOptions> = {},
) {
  const calls: Call[] = [];
  const navigations: string[] = [];
  const replaced: string[] = [];
  const storage = new MemoryStorage();
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body =
        init?.body instanceof URLSearchParams ? init.body : undefined;

      calls.push({ url, body });

      if (url.endsWith("/.well-known/openid-configuration")) {
        return json(DISCOVERY);
      }

      const authorize = [...navigations]
        .reverse()
        .find((nav) => nav.startsWith(DISCOVERY.authorization_endpoint));
      const nonce = authorize
        ? (new URL(authorize).searchParams.get("nonce") ?? "")
        : "";

      return token(body ?? new URLSearchParams(), nonce);
    },
  );
  const client = createCanopyBrowserClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: "https://app.test/signed-out",
    storage,
    navigate: (url) => navigations.push(url),
    replaceUrl: (url) => replaced.push(url),
    fetch,
    now: () => NOW,
    ...overrides,
  });

  return { client, calls, navigations, replaced, storage };
}

/** Start a sign-in and answer it the way Canopy's redirect would. */
async function callback(
  h: ReturnType<typeof harness>,
  answer: Record<string, string> = { code: "code-1" },
): Promise<{ url: string; authorize: URL }> {
  await h.client.signIn({ returnTo: "/reports" });

  const authorize = new URL(h.navigations.at(-1) as string);
  const url = new URL(REDIRECT_URI);

  url.search = new URLSearchParams({
    ...answer,
    state: authorize.searchParams.get("state") as string,
  }).toString();

  return { url: url.toString(), authorize };
}

function tokens(extra: Record<string, unknown> = {}): Response {
  return json({
    access_token: "access-1",
    id_token: idToken(),
    refresh_token: "refresh-1",
    token_type: "Bearer",
    expires_in: 900,
    ...extra,
  });
}

describe("signIn", () => {
  it("sends the browser to the authorize endpoint with PKCE S256, state and nonce", async () => {
    const h = harness();

    await h.client.signIn({ prompt: "login", organization: "org-1" });

    const authorize = new URL(h.navigations[0] as string);
    const params = authorize.searchParams;

    expect(authorize.origin + authorize.pathname).toBe(
      DISCOVERY.authorization_endpoint,
    );
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("openid profile email");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("prompt")).toBe("login");
    expect(params.get("organization")).toBe("org-1");
    expect(params.get("nonce")).toBeTruthy();
    expect(h.storage.items.size).toBe(1);
  });

  it("keeps no token in storage, only the verifier for the round trip", async () => {
    const h = harness();
    const { url } = await callback(h);

    await h.client.handleRedirect(url);

    expect(h.storage.items.size).toBe(0);
  });
});

describe("handleRedirect", () => {
  it("exchanges the code with the client id and the verifier, and no secret", async () => {
    const h = harness();
    const { url } = await callback(h);
    const result = await h.client.handleRedirect(url);
    const exchange = h.calls.find(
      (call) => call.url === DISCOVERY.token_endpoint,
    );

    expect(result).toEqual({ status: "signed-in", returnTo: "/reports" });
    expect(exchange?.body?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.body?.get("client_id")).toBe(CLIENT_ID);
    expect(exchange?.body?.get("code")).toBe("code-1");
    expect(exchange?.body?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange?.body?.has("client_secret")).toBe(false);
    expect(h.client.getClaims()?.email).toBe("ada@example.test");
    expect(await h.client.getAccessToken()).toBe("access-1");
  });

  it("takes the response parameters out of the URL", async () => {
    const h = harness();
    const { url } = await callback(h);

    await h.client.handleRedirect(`${url}&iss=x`);

    expect(h.replaced).toEqual([REDIRECT_URI]);
  });

  it("refuses a response to a sign-in this browser did not start", async () => {
    const h = harness();
    const result = await h.client.handleRedirect(
      `${REDIRECT_URI}?code=stolen&state=someone-elses`,
    );

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe(
      "state_mismatch",
    );
    expect(h.calls.some((call) => call.url === DISCOVERY.token_endpoint)).toBe(
      false,
    );
  });

  it("answers login_required and interaction_required as needing sign-in", async () => {
    for (const code of ["login_required", "interaction_required"]) {
      const h = harness();
      const { url } = await callback(h, { error: code });
      const result = await h.client.handleRedirect(url);

      expect(result.status).toBe("error");
      expect(result.status === "error" && result.error.needsSignIn).toBe(true);
      expect(h.client.isSignedIn()).toBe(false);
    }
  });

  it("refuses an ID token minted for another sign-in", async () => {
    const h = harness(() => tokens({ id_token: idToken({ nonce: "other" }) }));
    const { url } = await callback(h);
    const result = await h.client.handleRedirect(url);

    expect(result.status === "error" && result.error.code).toBe(
      "invalid_token",
    );
    expect(h.client.isSignedIn()).toBe(false);
  });

  it("refuses an ID token for another client or issuer", async () => {
    for (const claims of [
      { aud: "someone-else" },
      { iss: "https://evil.test" },
    ]) {
      const h = harness((_body, nonce) =>
        tokens({ id_token: idToken({ ...claims, nonce }) }),
      );
      const { url } = await callback(h);
      const result = await h.client.handleRedirect(url);

      expect(result.status === "error" && result.error.code).toBe(
        "invalid_token",
      );
    }
  });

  it("is signed out when the URL carries no answer", async () => {
    const h = harness();

    expect(await h.client.handleRedirect(`${REDIRECT_URI}?tab=1`)).toEqual({
      status: "signed-out",
    });
  });
});

describe("start", () => {
  it("resumes Canopy's session with prompt=none when nothing is in memory", async () => {
    const h = harness();
    const result = await h.client.start("https://app.test/");

    expect(result).toEqual({ status: "redirecting" });
    expect(new URL(h.navigations[0] as string).searchParams.get("prompt")).toBe(
      "none",
    );
  });

  it("finishes the sign-in when Canopy has just answered", async () => {
    const h = harness();
    const { url } = await callback(h);

    expect((await h.client.start(url)).status).toBe("signed-in");
  });
});

describe("refresh", () => {
  async function signedIn(
    refresh: () => Response | Promise<Response>,
    overrides: Partial<CanopyBrowserClientOptions> = {},
  ) {
    const h = harness(
      (body, nonce) =>
        body.get("grant_type") === "refresh_token"
          ? refresh()
          : tokens({ id_token: idToken({ nonce }) }),
      overrides,
    );
    const { url } = await callback(h);

    await h.client.handleRedirect(url);

    return h;
  }

  it("refreshes with the client id alone before the token expires", async () => {
    let clock = NOW;
    const h = await signedIn(
      () =>
        json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 900,
        }),
      { now: () => clock },
    );

    clock += 850 * 1000;

    expect(await h.client.getAccessToken()).toBe("access-2");

    const refresh = h.calls.at(-1);

    expect(refresh?.body?.get("grant_type")).toBe("refresh_token");
    expect(refresh?.body?.get("refresh_token")).toBe("refresh-1");
    expect(refresh?.body?.has("client_secret")).toBe(false);
    expect(h.client.getClaims()?.sub).toBe("identity-1");
  });

  it("sends one request for concurrent refreshes, so the rotated token is presented once", async () => {
    const h = await signedIn(() =>
      json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 900,
      }),
    );

    await Promise.all([
      h.client.refresh(),
      h.client.refresh(),
      h.client.refresh(),
    ]);

    const refreshes = h.calls.filter(
      (call) => call.body?.get("grant_type") === "refresh_token",
    );

    expect(refreshes).toHaveLength(1);
  });

  it("ends the session in memory and says so when Canopy refuses the refresh", async () => {
    const ended: CanopyAuthError[] = [];
    let clock = NOW;
    const h = await signedIn(
      () => json({ error: "invalid_grant", error_description: "expired" }, 400),
      { now: () => clock, onSessionEnd: (error) => ended.push(error) },
    );

    clock += 900 * 1000;

    expect(await h.client.getAccessToken()).toBeNull();
    expect(h.client.isSignedIn()).toBe(false);
    expect(ended.map((error) => error.code)).toEqual(["invalid_grant"]);
  });
});

describe("signOut", () => {
  it("revokes the refresh token, then ends Canopy's session with the ID token hint", async () => {
    const h = harness();
    const { url } = await callback(h);

    await h.client.handleRedirect(url);
    h.navigations.length = 0;
    await h.client.signOut();

    const revoke = h.calls.find(
      (call) => call.url === DISCOVERY.revocation_endpoint,
    );
    const endSession = new URL(h.navigations[0] as string);

    expect(revoke?.body?.get("token")).toBe("refresh-1");
    expect(revoke?.body?.has("client_secret")).toBe(false);
    expect(endSession.origin + endSession.pathname).toBe(
      DISCOVERY.end_session_endpoint,
    );
    expect(endSession.searchParams.get("id_token_hint")).toBeTruthy();
    expect(endSession.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/signed-out",
    );
    expect(h.client.isSignedIn()).toBe(false);
  });
});

describe("errors", () => {
  it("names the allowed web origins when no response can be read", async () => {
    const h = harness(() => {
      throw new TypeError("Failed to fetch");
    });
    const { url } = await callback(h);

    const failure = h.client.handleRedirect(url);

    await expect(failure).rejects.toBeInstanceOf(CanopyConnectionError);
    await expect(failure).rejects.toThrow(/Allowed web origins/);
  });

  it("refuses a discovery document for another issuer", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(json({ ...DISCOVERY, issuer: "https://evil.test" })),
    );
    const client = createCanopyBrowserClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      storage: new MemoryStorage(),
      navigate: () => undefined,
      fetch,
    });

    await expect(client.signIn()).rejects.toMatchObject({
      code: "invalid_issuer",
    });
  });

  it("treats an issuer with trailing slashes as the same issuer", async () => {
    const h = harness(undefined, { issuer: `${ISSUER}///` });

    await h.client.signIn();

    expect(h.calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(h.navigations).toHaveLength(1);
  });

  it("refuses to build without an issuer, client id and redirect URI", () => {
    expect(() =>
      createCanopyBrowserClient({
        issuer: "",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).toThrow(TypeError);
  });
});
