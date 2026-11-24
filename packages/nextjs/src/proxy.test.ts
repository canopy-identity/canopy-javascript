import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "./config";
import { canopyProxy } from "./proxy";
import { readSession, sessionWrites, type StoredSession } from "./session";
import {
  APP_URL,
  BASE,
  CLIENT_ID,
  fakeCanopy,
  ISSUER,
  json,
  type FakeCanopy,
} from "./testing/fake-canopy";

const SECRET = "a-test-secret-that-is-at-least-32-characters";
const CLIENT_SECRET = "client-secret-value";

let canopy: FakeCanopy;

beforeEach(async () => {
  canopy = await fakeCanopy();
  vi.stubGlobal("fetch", canopy.fetch);
  vi.stubEnv("CANOPY_ISSUER", ISSUER);
  vi.stubEnv("CANOPY_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CANOPY_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("CANOPY_SECRET", SECRET);
  vi.stubEnv("CANOPY_APP_URL", APP_URL);
  vi.stubEnv("CANOPY_BASE_URL", BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A request carrying the given cookies. */
function requestTo(
  path: string,
  cookies: { name: string; value: string }[] = [],
): NextRequest {
  return new NextRequest(`${APP_URL}${path}`, {
    headers: cookies.length
      ? {
          cookie: cookies
            .map(({ name, value }) => `${name}=${value}`)
            .join("; "),
        }
      : {},
  });
}

/** The cookies a session is stored in, as the browser would send them back. */
async function sessionCookies(session: StoredSession) {
  const writes = await sessionWrites(
    session,
    { getAll: () => [] },
    resolveConfig(),
  );

  return writes.map(({ name, value }) => ({ name, value }));
}

async function validSession(
  overrides: Partial<StoredSession> = {},
): Promise<StoredSession> {
  return {
    at: await canopy.accessToken(),
    rt: "rt_live",
    it: await canopy.idToken("n"),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

function setCookies(
  response: Response,
): { name: string; value: string; raw: string }[] {
  return response.headers.getSetCookie().map((raw) => {
    const [pair = ""] = raw.split(";");
    const [name = "", ...rest] = pair.split("=");

    return { name, value: rest.join("="), raw };
  });
}

describe("signing in", () => {
  it("sends the browser to Canopy with PKCE, a state and a nonce, and seals them in a cookie", async () => {
    const proxy = canopyProxy();
    const response = await proxy(
      requestTo("/auth/sign-in?returnTo=/reports/2026"),
    );
    const location = new URL(response.headers.get("location") ?? "");
    const tx = setCookies(response).find(
      (cookie) => cookie.name === "canopy_tx",
    );

    expect(response.status).toBe(307);
    expect(`${location.origin}${location.pathname}`).toBe(
      `${BASE}/oauth/authorize`,
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${APP_URL}/auth/callback`,
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.search).not.toContain(CLIENT_SECRET);
    expect(tx?.raw).toMatch(/HttpOnly/i);
    expect(tx?.raw).toMatch(/SameSite=lax/i);
    expect(tx?.raw).toMatch(/Secure/i);
    expect(tx?.value).not.toContain("/reports");
  });

  it("finishes the sign-in: one code exchange, the session sealed in HttpOnly cookies, back to the page", async () => {
    const proxy = canopyProxy();
    const started = await proxy(
      requestTo("/auth/sign-in?returnTo=/reports/2026"),
    );
    const authorize = new URL(started.headers.get("location") ?? "");
    const tx = setCookies(started).find(
      (cookie) => cookie.name === "canopy_tx",
    );

    canopy.nonce = authorize.searchParams.get("nonce") ?? "";

    const response = await proxy(
      requestTo(
        `/auth/callback?code=code_1&state=${authorize.searchParams.get("state")}`,
        [{ name: "canopy_tx", value: tx?.value ?? "" }],
      ),
    );
    const exchanges = canopy.requests.filter(
      (r) => r.url.pathname === "/oauth/token",
    );
    const written = setCookies(response);
    const session = written.filter((cookie) =>
      cookie.name.startsWith("canopy_session."),
    );

    expect(response.headers.get("location")).toBe(`${APP_URL}/reports/2026`);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body?.get("grant_type")).toBe("authorization_code");
    expect(exchanges[0]?.body?.get("code_verifier")).toBeTruthy();
    expect(exchanges[0]?.body?.get("client_secret")).toBe(CLIENT_SECRET);
    expect(session.length).toBeGreaterThan(0);
    expect(session.every((cookie) => /HttpOnly/i.test(cookie.raw))).toBe(true);
    expect(written.find((cookie) => cookie.name === "canopy_tx")?.raw).toMatch(
      /Max-Age=0/,
    );

    // The tokens are sealed: no JWT and no refresh token appears in a
    // cookie or the redirect.
    expect(response.headers.get("set-cookie")).not.toContain("eyJ");
    expect(response.headers.get("set-cookie")).not.toContain("rt_1");
    expect(response.headers.get("location")).not.toContain("eyJ");

    const stored = await readSession(
      { getAll: () => session.map(({ name, value }) => ({ name, value })) },
      resolveConfig(),
    );

    expect(stored?.rt).toBe("rt_1");
  });

  it("refuses a callback whose state is not the sign-in's, and exchanges nothing", async () => {
    const proxy = canopyProxy();
    const started = await proxy(requestTo("/auth/sign-in"));
    const tx = setCookies(started).find(
      (cookie) => cookie.name === "canopy_tx",
    );
    const response = await proxy(
      requestTo("/auth/callback?code=code_1&state=forged", [
        { name: "canopy_tx", value: tx?.value ?? "" },
      ]),
    );

    expect(response.status).toBe(400);
    expect(
      canopy.requests.filter((r) => r.url.pathname === "/oauth/token"),
    ).toHaveLength(0);
  });

  it("refuses an ID token whose nonce is not the sign-in's", async () => {
    const proxy = canopyProxy();
    const started = await proxy(requestTo("/auth/sign-in"));
    const authorize = new URL(started.headers.get("location") ?? "");
    const tx = setCookies(started).find(
      (cookie) => cookie.name === "canopy_tx",
    );

    canopy.nonce = "someone-elses";

    await expect(
      proxy(
        requestTo(
          `/auth/callback?code=code_1&state=${authorize.searchParams.get("state")}`,
          [{ name: "canopy_tx", value: tx?.value ?? "" }],
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_nonce" });
  });

  it("returns only to a path on this site", async () => {
    const proxy = canopyProxy();

    for (const returnTo of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
    ]) {
      const started = await proxy(
        requestTo(`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`),
      );
      const authorize = new URL(started.headers.get("location") ?? "");
      const tx = setCookies(started).find(
        (cookie) => cookie.name === "canopy_tx",
      );
      const back = await proxy(
        requestTo(
          `/auth/callback?error=access_denied&state=${authorize.searchParams.get("state")}`,
          [{ name: "canopy_tx", value: tx?.value ?? "" }],
        ),
      );

      expect(back.headers.get("location")).toBe(`${APP_URL}/`);
    }
  });
});

describe("a request with a session", () => {
  it("sends nothing to Canopy while the access token is valid", async () => {
    const proxy = canopyProxy({ protect: ["/reports"] });
    const cookies = await sessionCookies(await validSession());

    for (let i = 0; i < 10; i += 1) {
      const response = await proxy(requestTo("/reports/2026", cookies));

      expect(response.headers.get("location")).toBeNull();
    }

    expect(canopy.requests).toHaveLength(0);
  });

  it("refreshes once shortly before expiry, and the page renders with the new session", async () => {
    const proxy = canopyProxy();
    const cookies = await sessionCookies(
      await validSession({ exp: Math.floor(Date.now() / 1000) + 30 }),
    );
    const response = await proxy(requestTo("/reports", cookies));
    const refreshes = canopy.requests.filter(
      (r) => r.url.pathname === "/oauth/token",
    );
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";

    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.body?.get("grant_type")).toBe("refresh_token");
    expect(refreshes[0]?.body?.get("refresh_token")).toBe("rt_live");
    expect(
      setCookies(response).some((c) => c.name.startsWith("canopy_session.")),
    ).toBe(true);
    expect(forwarded).toContain("canopy_session.0=");
  });

  it("sends one refresh for requests of one page that arrive together", async () => {
    const proxy = canopyProxy();
    const cookies = await sessionCookies(
      await validSession({ exp: Math.floor(Date.now() / 1000) + 30 }),
    );

    await Promise.all(
      [
        "/reports",
        "/reports/a",
        "/reports/b",
        "/_next/data/x.json",
        "/api/deals",
      ].map((path) => proxy(requestTo(path, cookies))),
    );

    expect(
      canopy.requests.filter((r) => r.url.pathname === "/oauth/token"),
    ).toHaveLength(1);
  });

  it("clears the session when Canopy refuses the refresh, and a protected page sends the person to sign in", async () => {
    canopy.tokenAnswer = () =>
      Promise.resolve(
        json({ error: "invalid_grant", error_description: "ended" }, 400),
      );

    const proxy = canopyProxy({ protect: ["/reports"] });
    const cookies = await sessionCookies(
      await validSession({ exp: Math.floor(Date.now() / 1000) + 30 }),
    );
    const response = await proxy(requestTo("/reports/2026?tab=q1", cookies));
    const location = new URL(response.headers.get("location") ?? "");

    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("returnTo")).toBe("/reports/2026?tab=q1");
    expect(
      setCookies(response)
        .filter((cookie) => cookie.name.startsWith("canopy_session."))
        .every((cookie) => /Max-Age=0/.test(cookie.raw)),
    ).toBe(true);
  });
});

describe("a request without a session", () => {
  it("sends a signed-out visitor to sign in from a protected path, and lets an open path render", async () => {
    const proxy = canopyProxy({ protect: ["/reports"] });
    const guarded = await proxy(requestTo("/reports"));
    const open = await proxy(requestTo("/pricing"));

    expect(new URL(guarded.headers.get("location") ?? "").pathname).toBe(
      "/auth/sign-in",
    );
    expect(open.headers.get("location")).toBeNull();
    expect(canopy.requests).toHaveLength(0);
  });

  it("treats a cookie it cannot open as no session", async () => {
    const proxy = canopyProxy({ protect: ["/reports"] });
    const response = await proxy(
      requestTo("/reports", [
        { name: "canopy_session.0", value: "v1.tampered" },
      ]),
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/auth/sign-in",
    );
  });
});

describe("signing out", () => {
  it("revokes the refresh token, clears the cookies and ends Canopy's session", async () => {
    const proxy = canopyProxy();
    const session = await validSession();
    const response = await proxy(
      requestTo("/auth/sign-out", await sessionCookies(session)),
    );
    const location = new URL(response.headers.get("location") ?? "");
    const revoked = canopy.requests.find(
      (r) => r.url.pathname === "/oauth/revoke",
    );

    expect(revoked?.body?.get("token")).toBe("rt_live");
    expect(`${location.origin}${location.pathname}`).toBe(
      `${BASE}/auth/logout`,
    );
    expect(location.searchParams.get("id_token_hint")).toBe(session.it);
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(
      `${APP_URL}/`,
    );
    expect(
      setCookies(response)
        .filter((cookie) => cookie.name.startsWith("canopy_session."))
        .every((cookie) => /Max-Age=0/.test(cookie.raw)),
    ).toBe(true);
  });
});

describe("protect", () => {
  it("covers a path and everything under it, with or without a trailing slash", async () => {
    const proxy = canopyProxy({ protect: ["/reports///"] });

    for (const path of ["/reports", "/reports/2026"]) {
      const response = await proxy(requestTo(path));

      expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
        "/auth/sign-in",
      );
    }

    expect(
      (await proxy(requestTo("/reportsx"))).headers.get("location"),
    ).toBeNull();
  });

  it("trims a long run of slashes quickly", async () => {
    const proxy = canopyProxy({ protect: [`/reports${"/".repeat(100_000)}x`] });
    const started = performance.now();

    await proxy(requestTo(`/${"/".repeat(100_000)}`));

    expect(performance.now() - started).toBeLessThan(500);
  });
});
