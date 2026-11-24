import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "./auth";
import { resolveConfig } from "./config";
import { sessionWrites } from "./session";
import {
  APP_URL,
  BASE,
  CLIENT_ID,
  fakeCanopy,
  ISSUER,
  type FakeCanopy,
} from "./testing/fake-canopy";

/**
 * What one signed-in person's hour costs Canopy in grants and hierarchy
 * reads: a page every 30 seconds, each checking three permissions at nodes.
 * Run once on a long-running server, where the process keeps its cache, and
 * once as a serverless host at its worst, where every page lands on a cold
 * instance. `docs/PLAN_ECONOMICS.md` in the Canopy repository records these
 * figures; a change here changes what a plan costs to serve.
 */

let jar: { name: string; value: string }[] = [];

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => jar }),
}));

const PAGES_AN_HOUR = 120;
const SHARED = Symbol.for("@canopy-io/nextjs.shared");

let canopy: FakeCanopy;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  canopy = await fakeCanopy();
  coldStart();
  vi.stubGlobal("fetch", canopy.fetch);
  vi.stubEnv("CANOPY_ISSUER", ISSUER);
  vi.stubEnv("CANOPY_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CANOPY_CLIENT_SECRET", "client-secret-value");
  vi.stubEnv("CANOPY_SECRET", "a-test-secret-that-is-at-least-32-characters");
  vi.stubEnv("CANOPY_APP_URL", APP_URL);
  vi.stubEnv("CANOPY_BASE_URL", BASE);
  vi.stubEnv("CANOPY_API_KEY", "cnpy_sk_test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A new instance: nothing cached in the process. */
function coldStart(): void {
  const shared = (
    globalThis as Record<
      symbol,
      | { verifiers: Map<string, unknown>; authorizers: Map<string, unknown> }
      | undefined
    >
  )[SHARED];

  shared?.verifiers.clear();
  shared?.authorizers.clear();
}

async function page(): Promise<void> {
  const writes = await sessionWrites(
    {
      at: await canopy.accessToken(),
      rt: "rt_live",
      exp: Math.floor(Date.now() / 1000) + 900,
    },
    { getAll: () => [] },
    resolveConfig(),
  );

  jar = writes.map(({ name, value }) => ({ name, value }));

  const { can } = await auth();

  await can("deals.update", { nodeId: "frontend" });
  await can("deals.update", { nodeId: "sales" });
  await can("deals.update", { nodeId: "engineering" });
}

function tally() {
  const reads = canopy.requests.filter((r) =>
    r.url.pathname.startsWith("/api/v1/"),
  );
  const grants = reads.filter((r) => r.url.pathname.endsWith("/grants"));
  const tree = reads.filter((r) => r.url.pathname === "/api/v1/nodes/parents");
  const conditional = (list: typeof reads) =>
    list.filter((r) => r.headers.get("if-none-match") !== null).length;

  return {
    grants: grants.length,
    grantsConditional: conditional(grants),
    tree: tree.length,
    treeConditional: conditional(tree),
  };
}

describe("one signed-in person's hour", () => {
  it("on a long-running server: one grants read a minute, every one after the first conditional", async () => {
    for (let i = 0; i < PAGES_AN_HOUR; i += 1) {
      await page();
      vi.setSystemTime(Date.now() + 30_000);
    }

    expect(tally()).toEqual({
      grants: 60,
      grantsConditional: 59,
      tree: 60,
      treeConditional: 59,
    });
  });

  it("on a serverless host where every page is a cold start: one full read a page", async () => {
    for (let i = 0; i < PAGES_AN_HOUR; i += 1) {
      coldStart();
      await page();
      vi.setSystemTime(Date.now() + 30_000);
    }

    expect(tally()).toEqual({
      grants: PAGES_AN_HOUR,
      grantsConditional: 0,
      tree: PAGES_AN_HOUR,
      treeConditional: 0,
    });
  });
});
