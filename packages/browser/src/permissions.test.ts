import { describe, expect, it } from "vitest";

import { createCanopyBrowserClient } from "./client.js";
import { CanopyAuthError } from "./errors.js";
import { EVALUATE_MAX_CHECKS, FAILED_CHECK_RETRY_MS } from "./permissions.js";

const ISSUER = "https://auth.test/environments/env-1";
const CLIENT_ID = "client-1";
const REDIRECT_URI = "https://app.test/callback";
const NOW = 1_800_000_000_000;
const EVALUATE = "https://auth.test/v1/identity/auth/me/permissions/evaluate";
const LIST = "https://auth.test/v1/identity/auth/me/permissions";
const ORGANIZATIONS = "https://auth.test/v1/identity/auth/organizations";

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

function jwt(claims: Record<string, unknown>): string {
  return [encode({ alg: "RS256" }), encode(claims), "signature"].join(".");
}

function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

interface Evaluated {
  checks: { permission: string; scope: string; node_id?: string }[];
  authorization: string | null;
}

/**
 * A signed-in client over a stand-in Canopy. `accessClaims` are the access
 * token's; each refresh issues the next access token in `refreshed`.
 * `decide` answers each evaluate check.
 */
async function signedIn(
  options: {
    accessClaims?: Record<string, unknown>;
    refreshed?: Record<string, unknown>[];
    decide?: (check: { permission: string; node_id?: string }) => boolean;
    evaluate?: (body: Evaluated) => Response | undefined;
    list?: string[];
    organizations?: (url: URL) => Response;
  } = {},
) {
  let clock = NOW;
  let nonce = "";
  let issued = 0;

  const evaluated: Evaluated[] = [];
  const listed: string[] = [];
  const organizationReads: URL[] = [];
  const navigations: string[] = [];
  const storage = new MemoryStorage();
  const refreshed = [...(options.refreshed ?? [])];
  const decide = options.decide ?? (() => true);

  const accessToken = (claims: Record<string, unknown>) =>
    jwt({ iss: ISSUER, sub: "identity-1", exp: clock / 1000 + 900, ...claims });

  const client = createCanopyBrowserClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    storage,
    navigate: (url) => {
      navigations.push(url);
      nonce = new URL(url).searchParams.get("nonce") ?? nonce;
    },
    replaceUrl: () => undefined,
    now: () => clock,
    fetch: (input, init) => Promise.resolve(route(input, init)),
  });

  function route(
    input: string | URL | Request,
    init: RequestInit | undefined,
  ): Response {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(init?.headers);

    if (url.endsWith("/.well-known/openid-configuration")) {
      return json(DISCOVERY);
    }

    if (url === DISCOVERY.token_endpoint) {
      issued += 1;

      const claims =
        issued === 1 ? (options.accessClaims ?? {}) : (refreshed.shift() ?? {});

      return json({
        access_token: accessToken(claims),
        id_token: jwt({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: "identity-1",
          iat: clock / 1000,
          exp: clock / 1000 + 900,
          nonce,
        }),
        refresh_token: `refresh-${issued}`,
        expires_in: 900,
      });
    }

    if (url === DISCOVERY.revocation_endpoint) {
      return json({});
    }

    if (url === EVALUATE) {
      const body = {
        ...(JSON.parse(init?.body as string) as Pick<Evaluated, "checks">),
        authorization: headers.get("authorization"),
      };

      evaluated.push(body);

      return (
        options.evaluate?.(body) ??
        json({
          items: body.checks.map((check) => ({
            allowed: decide(check),
            denial_reason: decide(check) ? null : "no_matching_grant",
          })),
        })
      );
    }

    if (url === LIST) {
      listed.push(headers.get("authorization") ?? "");

      return json({ items: options.list ?? [] });
    }

    if (url.startsWith(ORGANIZATIONS)) {
      const read = new URL(url);

      organizationReads.push(read);

      return (
        options.organizations?.(read) ??
        json({ items: [], pagination: { page: 1, page_count: 1 } })
      );
    }

    throw new Error(`unexpected request to ${url}`);
  }

  await client.signIn();

  const authorize = new URL(navigations.at(-1) as string);
  const back = new URL(REDIRECT_URI);

  back.search = new URLSearchParams({
    code: "code-1",
    state: authorize.searchParams.get("state") as string,
  }).toString();
  await client.start({ url: back.toString() });

  return {
    client,
    evaluated,
    listed,
    organizationReads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Let queued checks flush and their answers arrive. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("answered from the token", () => {
  it("answers an Environment-wide check from `permissions` with no request", async () => {
    const h = await signedIn({ accessClaims: { permissions: ["deals.read"] } });

    expect(await h.client.checkPermission("deals.read")).toBe(true);
    expect(await h.client.checkPermission("deals.delete")).toBe(false);
    expect(h.client.getPermissionState("deals.read")).toEqual({
      status: "allowed",
    });
    expect(h.evaluated).toHaveLength(0);
  });

  it("answers a check at the session's organization from `org_permissions` with no request", async () => {
    const h = await signedIn({
      accessClaims: { org_id: "org-1", org_permissions: ["deals.read"] },
    });

    expect(
      await h.client.checkPermission("deals.read", { nodeId: "org-1" }),
    ).toBe(true);
    expect(
      await h.client.checkPermission("deals.delete", { nodeId: "org-1" }),
    ).toBe(false);
    expect(h.evaluated).toHaveLength(0);
  });

  it("asks the API for a key off a list that overflowed", async () => {
    const h = await signedIn({
      accessClaims: { permissions: ["deals.read"], permissions_overflow: true },
    });

    expect(await h.client.checkPermission("deals.read")).toBe(true);
    expect(await h.client.checkPermission("deals.export")).toBe(true);
    expect(h.evaluated).toHaveLength(1);
    expect(h.evaluated[0]?.checks).toEqual([
      { permission: "deals.export", scope: "app_wide" },
    ]);
  });

  it("asks the API when the token carries no permission claims", async () => {
    const h = await signedIn();

    expect(await h.client.checkPermission("deals.read")).toBe(true);
    expect(h.evaluated).toHaveLength(1);
  });

  it("reads the access token's claims", async () => {
    const h = await signedIn({
      accessClaims: { org_id: "org-1", org_roles: ["admin"], plan: "pro" },
    });

    expect(h.client.getAccessTokenClaims<{ plan?: string }>()).toMatchObject({
      org_id: "org-1",
      org_roles: ["admin"],
      plan: "pro",
    });
  });
});

describe("asked of the API", () => {
  it("sends the checks of one tick in one request, with the access token", async () => {
    const h = await signedIn({
      decide: (check) => check.permission !== "deals.delete",
    });

    const answers = await Promise.all([
      h.client.checkPermission("deals.read", { nodeId: "team-1" }),
      h.client.checkPermission("deals.delete", { nodeId: "team-1" }),
      h.client.checkPermissions([
        { permission: "deals.read", nodeId: "team-2" },
        { permission: "reports.read" },
      ]),
    ]);

    expect(answers).toEqual([true, false, [true, true]]);
    expect(h.evaluated).toHaveLength(1);
    expect(h.evaluated[0]?.authorization).toMatch(/^Bearer /);
    expect(h.evaluated[0]?.checks).toEqual([
      { permission: "deals.read", scope: "node", node_id: "team-1" },
      { permission: "deals.delete", scope: "node", node_id: "team-1" },
      { permission: "deals.read", scope: "node", node_id: "team-2" },
      { permission: "reports.read", scope: "app_wide" },
    ]);
    expect(
      h.client.getPermissionState("deals.delete", { nodeId: "team-1" }),
    ).toEqual({ status: "denied", reason: "no_matching_grant" });
  });

  it(`splits more than ${EVALUATE_MAX_CHECKS} checks into requests the API accepts`, async () => {
    const h = await signedIn();

    await h.client.checkPermissions(
      Array.from({ length: EVALUATE_MAX_CHECKS + 1 }, (_, i) => ({
        permission: `p.${i}`,
        nodeId: "team-1",
      })),
    );

    expect(h.evaluated.map((body) => body.checks.length)).toEqual([
      EVALUATE_MAX_CHECKS,
      1,
    ]);
  });

  it("never sends a check it holds or is already asking", async () => {
    const h = await signedIn();

    await Promise.all([
      h.client.checkPermission("deals.read", { nodeId: "team-1" }),
      h.client.checkPermission("deals.read", { nodeId: "team-1" }),
    ]);
    await h.client.checkPermission("deals.read", { nodeId: "team-1" });

    expect(h.evaluated).toHaveLength(1);
    expect(h.evaluated[0]?.checks).toHaveLength(1);
  });

  it("makes no request because time passed", async () => {
    const h = await signedIn();

    await h.client.checkPermission("deals.read", { nodeId: "team-1" });
    h.advance(10 * 60 * 1000);
    await h.client.checkPermission("deals.read", { nodeId: "team-1" });
    await settle();

    expect(h.evaluated).toHaveLength(1);
  });

  it("is loading until the answer arrives, and tells listeners when it does", async () => {
    const h = await signedIn();
    let calls = 0;

    h.client.subscribe(() => {
      calls += 1;
    });

    const asked = h.client.checkPermission("deals.read", { nodeId: "team-1" });

    expect(
      h.client.getPermissionState("deals.read", { nodeId: "team-1" }),
    ).toEqual({ status: "loading" });

    await asked;

    const state = h.client.getPermissionState("deals.read", {
      nodeId: "team-1",
    });

    expect(state).toEqual({ status: "allowed" });
    expect(
      h.client.getPermissionState("deals.read", { nodeId: "team-1" }),
    ).toBe(state);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("how long answers are held", () => {
  it("asks again after the token is refreshed", async () => {
    const h = await signedIn();

    await h.client.checkPermission("deals.read", { nodeId: "team-1" });
    await h.client.refresh();

    expect(
      h.client.getPermissionState("deals.read", { nodeId: "team-1" }),
    ).toEqual({ status: "loading" });

    await h.client.checkPermission("deals.read", { nodeId: "team-1" });

    expect(h.evaluated).toHaveLength(2);
  });

  it("answers from the new token after a refresh into another organization", async () => {
    const h = await signedIn({
      accessClaims: { org_id: "org-1", org_permissions: ["deals.read"] },
      refreshed: [{ org_id: "org-2", org_permissions: [] }],
    });

    expect(
      await h.client.checkPermission("deals.read", { nodeId: "org-1" }),
    ).toBe(true);

    await h.client.refresh();

    expect(
      await h.client.checkPermission("deals.read", { nodeId: "org-2" }),
    ).toBe(false);
    expect(h.evaluated).toHaveLength(0);
  });

  it("forgets every answer on sign-out", async () => {
    const h = await signedIn();

    await h.client.checkPermission("deals.read", { nodeId: "team-1" });
    await h.client.signOut();

    expect(
      h.client.getPermissionState("deals.read", { nodeId: "team-1" }),
    ).toEqual({ status: "loading" });
    expect(
      await h.client.checkPermission("deals.read", { nodeId: "team-1" }),
    ).toBe(false);
    expect(h.evaluated).toHaveLength(1);
  });
});

describe("when the API refuses", () => {
  it("holds the failure rather than asking on every call, then asks again later", async () => {
    const h = await signedIn({
      evaluate: () =>
        json(
          { error: { code: "rate_limited", message: "Too many requests" } },
          429,
          { "retry-after": "5" },
        ),
    });

    await expect(
      h.client.checkPermission("deals.read", { nodeId: "team-1" }),
    ).rejects.toBeInstanceOf(CanopyAuthError);
    await expect(
      h.client.checkPermission("deals.read", { nodeId: "team-1" }),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 5 });

    expect(h.evaluated).toHaveLength(1);
    expect(
      h.client.getPermissionState("deals.read", { nodeId: "team-1" }).status,
    ).toBe("error");

    h.advance(FAILED_CHECK_RETRY_MS);
    await h.client
      .checkPermission("deals.read", { nodeId: "team-1" })
      .catch(() => undefined);

    expect(h.evaluated).toHaveLength(2);
  });
});

describe("listPermissions", () => {
  it("reads the list once and holds it until the token changes", async () => {
    const h = await signedIn({ list: ["deals.read", "reports.read"] });

    expect(await h.client.listPermissions()).toEqual([
      "deals.read",
      "reports.read",
    ]);
    await h.client.listPermissions();

    expect(h.listed).toHaveLength(1);

    await h.client.refresh();
    await h.client.listPermissions();

    expect(h.listed).toHaveLength(2);
  });
});

describe("the person's organizations", () => {
  const ACME = {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    roles: [{ id: "role-1", name: "Admin" }],
    administers: true,
    portal_access: true,
  };
  const GLOBEX = { ...ACME, id: "org-2", name: "Globex", slug: "globex" };

  it("reads every page once, by name, and holds the list", async () => {
    const h = await signedIn({
      organizations: (url) =>
        json({
          items: url.searchParams.get("page") === "1" ? [ACME] : [GLOBEX],
          pagination: {
            page: Number(url.searchParams.get("page")),
            page_count: 2,
          },
        }),
    });

    expect(h.client.getOrganizationsState()).toEqual({ status: "loading" });

    const [first, second] = await Promise.all([
      h.client.listOrganizations(),
      h.client.listOrganizations(),
    ]);

    expect(first).toEqual([ACME, GLOBEX]);
    expect(second).toBe(first);
    expect(h.organizationReads.map((url) => url.search)).toEqual([
      "?page=1&take=100&sort_by=name&order=asc",
      "?page=2&take=100&sort_by=name&order=asc",
    ]);
    expect(h.client.getOrganizationsState()).toEqual({
      status: "loaded",
      organizations: [ACME, GLOBEX],
    });

    h.advance(10 * 60 * 1000);
    await h.client.listOrganizations();

    expect(h.organizationReads).toHaveLength(2);
  });

  it("reads again once the token changes, and tells subscribers", async () => {
    const h = await signedIn({
      organizations: () =>
        json({ items: [ACME], pagination: { page: 1, page_count: 1 } }),
    });
    let changes = 0;

    h.client.subscribe(() => {
      changes += 1;
    });
    await h.client.listOrganizations();
    await h.client.refresh();

    expect(h.client.getOrganizationsState()).toEqual({ status: "loading" });

    await h.client.listOrganizations();

    expect(h.organizationReads).toHaveLength(2);
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  it("holds a failure before asking again", async () => {
    let refuse = true;
    const h = await signedIn({
      organizations: () =>
        refuse
          ? json({ error: { code: "rate_limited" } }, 429, {
              "retry-after": "45",
            })
          : json({ items: [ACME], pagination: { page: 1, page_count: 1 } }),
    });

    await expect(h.client.listOrganizations()).rejects.toBeInstanceOf(
      CanopyAuthError,
    );
    expect(h.client.getOrganizationsState().status).toBe("error");

    refuse = false;
    h.advance(FAILED_CHECK_RETRY_MS);
    await expect(h.client.listOrganizations()).rejects.toBeInstanceOf(
      CanopyAuthError,
    );
    expect(h.organizationReads).toHaveLength(1);

    h.advance(15_000);
    await expect(h.client.listOrganizations()).resolves.toEqual([ACME]);
    expect(h.organizationReads).toHaveLength(2);
  });

  it("is empty after sign-out, with no request", async () => {
    const h = await signedIn();

    await h.client.signOut();

    await expect(h.client.listOrganizations()).resolves.toEqual([]);
    expect(h.organizationReads).toHaveLength(0);
  });
});
