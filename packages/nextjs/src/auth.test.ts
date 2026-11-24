import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "./auth";
import { clientSession } from "./client-session";
import { CanopyConfigError, resolveConfig } from "./config";
import { sessionWrites, type StoredSession } from "./session";
import {
  APP_URL,
  BASE,
  CLIENT_ID,
  fakeCanopy,
  ISSUER,
  type FakeCanopy,
} from "./testing/fake-canopy";

/** The cookies `auth()` reads through `next/headers`, set per test. */
let jar: { name: string; value: string }[] = [];

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => jar }),
}));

let canopy: FakeCanopy;

beforeEach(async () => {
  canopy = await fakeCanopy();
  jar = [];
  // Each test signs with a fresh key under the same kid, so the process-wide
  // verifier and authorizer start empty, as they would on a new instance.
  const shared = (
    globalThis as Record<
      symbol,
      | { verifiers: Map<string, unknown>; authorizers: Map<string, unknown> }
      | undefined
    >
  )[Symbol.for("@canopy-io/nextjs.shared")];

  shared?.verifiers.clear();
  shared?.authorizers.clear();
  vi.stubGlobal("fetch", canopy.fetch);
  vi.stubEnv("CANOPY_ISSUER", ISSUER);
  vi.stubEnv("CANOPY_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CANOPY_CLIENT_SECRET", "client-secret-value");
  vi.stubEnv("CANOPY_SECRET", "a-test-secret-that-is-at-least-32-characters");
  vi.stubEnv("CANOPY_APP_URL", APP_URL);
  vi.stubEnv("CANOPY_BASE_URL", BASE);
  vi.stubEnv("CANOPY_API_KEY", `cnpy_sk_${crypto.randomUUID()}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function signIn(
  claims: Record<string, unknown> = {},
  session: Partial<StoredSession> = {},
) {
  const stored: StoredSession = {
    at: await canopy.accessToken(claims),
    rt: "rt_live",
    it: await canopy.idToken("n"),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...session,
  };
  const writes = await sessionWrites(
    stored,
    { getAll: () => [] },
    resolveConfig(),
  );

  jar = writes.map(({ name, value }) => ({ name, value }));
}

function grantReads() {
  return canopy.requests.filter((r) => r.url.pathname.startsWith("/api/v1/"));
}

describe("auth()", () => {
  it("is signed out with no session cookie, and asks Canopy nothing", async () => {
    const session = await auth();

    expect(session.isSignedIn).toBe(false);
    expect(await session.can("deals.update")).toBe(false);
    expect(canopy.requests).toHaveLength(0);
  });

  it("reads the person and the organization, with nothing sent but the one read of the signing keys", async () => {
    await signIn({ org_id: "org_1", org_roles: ["Admin"] });

    const first = await auth();
    const second = await auth();

    expect(first.isSignedIn).toBe(true);
    expect(first.userId).toBe("identity_1");
    expect(first.user).toMatchObject({
      name: "Maya Chen",
      email: "maya@acme.io",
    });
    expect(first.user).not.toHaveProperty("nonce");
    expect(first.organization).toEqual({
      orgId: "org_1",
      orgRoles: ["Admin"],
      orgScope: null,
    });
    expect(second.isSignedIn).toBe(true);
    expect(canopy.callsToCanopy()).toHaveLength(0);
  });

  it("is signed out when the access token has expired or the cookie was altered", async () => {
    await signIn({ exp: Math.floor(Date.now() / 1000) - 3600 });

    expect((await auth()).isSignedIn).toBe(false);

    jar = [{ name: "canopy_session.0", value: "v1.altered" }];

    expect((await auth()).isSignedIn).toBe(false);
  });
});

describe("can()", () => {
  it("answers an Environment-wide check from the token, with no request", async () => {
    await signIn({ permissions: ["deals.export"] });

    const session = await auth();

    expect(await session.can("deals.export")).toBe(true);
    expect(await session.can("deals.delete")).toBe(false);
    expect(grantReads()).toHaveLength(0);
  });

  it("answers a check at the session's organization from the token, with no request", async () => {
    await signIn({
      org_id: "org_1",
      org_roles: [],
      org_permissions: ["members.invite"],
    });

    const session = await auth();

    expect(await session.can("members.invite", { nodeId: "org_1" })).toBe(true);
    expect(await session.can("members.remove", { nodeId: "org_1" })).toBe(
      false,
    );
    expect(grantReads()).toHaveLength(0);
  });

  it("asks the grants when the token's list was cut short", async () => {
    await signIn({ permissions: ["deals.export"], permissions_overflow: true });

    expect(await (await auth()).can("deals.update")).toBe(true);
    expect(grantReads().length).toBeGreaterThan(0);
  });

  it("evaluates a check at a node from the grants, and repeats it within 60 seconds with no request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await signIn();

    const session = await auth();

    expect(await session.can("deals.update", { nodeId: "frontend" })).toBe(
      true,
    );
    expect(await session.can("deals.update", { nodeId: "sales" })).toBe(false);

    const afterFirst = grantReads().length;

    for (let i = 0; i < 20; i += 1) {
      await (await auth()).can("deals.update", { nodeId: "frontend" });
    }

    expect(afterFirst).toBeGreaterThan(0);
    expect(grantReads()).toHaveLength(afterFirst);
  });

  it("revalidates after 60 seconds with the ETag, and keeps what it holds on 304", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await signIn();

    expect(
      await (await auth()).can("deals.update", { nodeId: "frontend" }),
    ).toBe(true);

    const before = grantReads().length;

    vi.setSystemTime(Date.now() + 61_000);
    await signIn();

    expect(
      await (await auth()).can("deals.update", { nodeId: "frontend" }),
    ).toBe(true);

    const revalidations = grantReads().slice(before);

    expect(revalidations.length).toBeGreaterThan(0);
    expect(
      revalidations.every((r) => r.headers.get("if-none-match") !== null),
    ).toBe(true);
  });

  it("says plainly that a check at a node needs CANOPY_API_KEY", async () => {
    vi.stubEnv("CANOPY_API_KEY", "");
    await signIn();

    await expect(
      (await auth()).can("deals.update", { nodeId: "frontend" }),
    ).rejects.toBeInstanceOf(CanopyConfigError);
  });
});

describe("clientSession()", () => {
  it("hands a client component who is signed in, and no token", async () => {
    await signIn({ org_id: "org_1", org_roles: ["Admin"] });

    const session = await auth();
    const forClient = JSON.stringify(clientSession(session));

    expect(JSON.parse(forClient)).toEqual({
      isSignedIn: true,
      userId: "identity_1",
      user: { sub: "identity_1", name: "Maya Chen", email: "maya@acme.io" },
      organization: { orgId: "org_1", orgRoles: ["Admin"], orgScope: null },
    });
    expect(forClient).not.toContain("eyJ");
    expect(forClient).not.toContain("rt_live");
  });
});
