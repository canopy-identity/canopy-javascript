import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { LocalAuthorizer } from "./authorizer.js";
import { isCanopyAuthorizerError } from "./errors.js";
import type { CanopyClient } from "./client.js";

/**
 *   root
 *    ├── engineering        ← the grant
 *    │    └── frontend          inherits
 *    └── sales                  does not
 *
 * As parent edges, which is what `GET /api/v1/nodes/parents` answers and all a
 * walk upward needs.
 */
const TREE = {
  items: [
    { id: "root", parent_node_id: null },
    { id: "engineering", parent_node_id: "root" },
    { id: "frontend", parent_node_id: "engineering" },
    { id: "sales", parent_node_id: "root" },
  ],
};

const GRANTS = {
  items: [{ permission: "reports.view", nodes: ["engineering"] }],
};

interface Harness {
  authorizer: LocalAuthorizer;
  request: ReturnType<typeof vi.fn>;
  requestConditional: ReturnType<typeof vi.fn>;
  advance: (ms: number) => void;
}

function makeAuthorizer(
  overrides: { grants?: unknown; ttlMs?: number } = {},
): Harness {
  let clock = 1_000;

  const request = vi.fn().mockResolvedValue(overrides.grants ?? GRANTS);

  const requestConditional = vi
    .fn()
    .mockResolvedValue({ modified: true, data: TREE, etag: 'W/"v1"' });

  const client = { request, requestConditional } as unknown as CanopyClient;

  const authorizer = new LocalAuthorizer(client, {
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
    now: () => clock,
  });

  return {
    authorizer,
    request,
    requestConditional,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const check = (nodeId: string) => ({
  identity_id: "id-1",
  permission: "reports.view",
  node_id: nodeId,
});

describe("LocalAuthorizer — deciding", () => {
  it("allows at the node the grant was made at", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("engineering"))).toEqual({
      allowed: true,
    });
  });

  it("allows at a descendant, by walking up to the grant", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
    });
  });

  it("denies on a different branch", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("sales"))).toEqual({
      allowed: false,
    });
  });

  it("denies above the grant, because inheritance runs down and not up", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("root"))).toEqual({
      allowed: false,
    });
  });

  it("denies a permission held nowhere without reading the tree", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "nothing.granted",
      node_id: "frontend",
    });

    expect(decision).toEqual({ allowed: false });
    expect(requestConditional).not.toHaveBeenCalled();
  });

  it("denies a node check that names no node", async () => {
    const { authorizer } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "reports.view",
    });

    expect(decision).toEqual({ allowed: false });
  });

  it("answers app_wide from the grants alone, with no tree", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "reports.view",
      scope: "app_wide",
    });

    expect(decision).toEqual({ allowed: true });
    expect(requestConditional).not.toHaveBeenCalled();
  });
});

describe("LocalAuthorizer — caching", () => {
  it("answers many checks from one pair of reads", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();

    for (let i = 0; i < 50; i++) {
      await authorizer.evaluate(check("frontend"));
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(requestConditional).toHaveBeenCalledTimes(1);
  });

  it("refetches grants once the window lapses", async () => {
    const { authorizer, request, advance } = makeAuthorizer({ ttlMs: 60_000 });

    await authorizer.evaluate(check("frontend"));

    advance(59_000);
    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(1);

    advance(2_000);
    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares one read across concurrent checks for the same identity", async () => {
    const { authorizer, request } = makeAuthorizer();

    // The cold-start stampede: without in-flight dedup this is one call each,
    // which is the per-request traffic the cache exists to remove.
    await Promise.all(
      Array.from({ length: 25 }, () => authorizer.evaluate(check("frontend"))),
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps grants per identity rather than sharing them", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reads the tree once for many identities", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    expect(requestConditional).toHaveBeenCalledTimes(1);
  });
});

describe("LocalAuthorizer — revalidating the hierarchy", () => {
  it("sends the held validator and keeps the tree on 304", async () => {
    const { authorizer, requestConditional, advance } = makeAuthorizer({
      ttlMs: 60_000,
    });

    await authorizer.evaluate(check("frontend"));

    requestConditional.mockResolvedValue({ modified: false });

    advance(61_000);

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
    });

    expect(requestConditional).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/nodes/parents",
      'W/"v1"',
      expect.anything(),
    );

    expect(authorizer.snapshot().treeNotModified).toBe(1);
  });

  it("adopts a moved node when the hierarchy changes", async () => {
    const { authorizer, requestConditional, advance } = makeAuthorizer({
      ttlMs: 60_000,
    });

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
    });

    // Frontend leaves Engineering. The grant is untouched and still correct —
    // which is exactly why refreshing only the grants would keep allowing it.
    requestConditional.mockResolvedValue({
      modified: true,
      etag: 'W/"v2"',
      data: {
        items: [
          { id: "root", parent_node_id: null },
          { id: "engineering", parent_node_id: "root" },
          { id: "sales", parent_node_id: "root" },
          { id: "frontend", parent_node_id: "sales" },
        ],
      },
    });

    advance(61_000);

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: false,
    });
  });

  it("counts what it saved", async () => {
    const { authorizer, requestConditional, advance } = makeAuthorizer({
      ttlMs: 60_000,
    });

    await authorizer.evaluate(check("frontend"));

    requestConditional.mockResolvedValue({ modified: false });

    advance(61_000);
    await authorizer.evaluate(check("frontend"));

    expect(authorizer.snapshot()).toEqual({
      grantFetches: 2,
      treeRequests: 2,
      treeNotModified: 1,
    });
  });

  it("bounds the reads it makes on the request path", async () => {
    // A hit costs nothing, but a miss holds an inbound request open exactly as
    // a per-request check used to — so the deadline and retry cap still have to
    // reach the client. They moved here from the guard; this is where they are
    // now proven.
    const clock = 1_000;

    const request = vi.fn().mockResolvedValue(GRANTS);
    const requestConditional = vi
      .fn()
      .mockResolvedValue({ modified: true, data: TREE, etag: 'W/"v1"' });

    const authorizer = new LocalAuthorizer(
      { request, requestConditional } as unknown as CanopyClient,
      { timeoutMs: 750, maxRetries: 0, now: () => clock },
    );

    await authorizer.evaluate(check("frontend"));

    expect(request.mock.calls[0]?.[2]).toEqual({
      timeoutMs: 750,
      maxRetries: 0,
      maxBackoffMs: 750,
    });

    expect(requestConditional.mock.calls[0]?.[3]).toEqual({
      timeoutMs: 750,
      maxRetries: 0,
      maxBackoffMs: 750,
    });
  });

  it("ends this caller's check on abort without cancelling a shared read", async () => {
    let release: (value: unknown) => void = () => undefined;

    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const authorizer = new LocalAuthorizer({
      request,
      requestConditional: vi
        .fn()
        .mockResolvedValue({ modified: true, data: TREE, etag: 'W/"v1"' }),
    } as unknown as CanopyClient);

    const controller = new AbortController();

    const mine = authorizer.evaluate(check("frontend"), {
      signal: controller.signal,
    });
    const theirs = authorizer.evaluate(check("frontend"));

    controller.abort(new Error("caller hung up"));

    await expect(mine).rejects.toThrow("caller hung up");

    // The shared read is still live for the other caller — aborting one
    // request must not cancel a fetch another is waiting on.
    release(GRANTS);

    expect(await theirs).toEqual({ allowed: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  /**
   * The opt-out, pinned as a contract rather than left as an accident of `??`.
   *
   * `ttlMs: 0` means every check reads fresh — the escape for anyone who cannot
   * accept a stale allow at all. It works because `??` only defaults on
   * nullish, so a single character (`||`) would silently restore 60s caching
   * for someone who had explicitly turned it off, and nothing else here would
   * notice.
   */
  it("reads fresh on every check when the window is zero", async () => {
    const { authorizer, request } = makeAuthorizer({ ttlMs: 0 });

    for (let i = 0; i < 5; i++) {
      await authorizer.evaluate(check("frontend"));
    }

    expect(request).toHaveBeenCalledTimes(5);
  });

  /**
   * The false-deny this exists to prevent.
   *
   * `GET /api/v1/nodes` answers a tree scoped to the caller, and a credential
   * without `hierarchy.view` gets an empty one — with a `200`, so nothing looks
   * broken. Walking off that map would answer `false` on every node-scoped
   * route: a silent, total denial that reads as ordinary policy.
   */
  it("refuses to decide when the tree does not contain the node", async () => {
    const request = vi.fn().mockResolvedValue(GRANTS);
    const requestConditional = vi
      .fn()
      .mockResolvedValue({ modified: true, data: { items: [] }, etag: null });

    const authorizer = new LocalAuthorizer({
      request,
      requestConditional,
    } as unknown as CanopyClient);

    const error = await authorizer
      .evaluate(check("frontend"))
      .catch((e: unknown) => e);

    expect(isCanopyAuthorizerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "authorizer.hierarchy_incomplete",
    );
  });

  it("still answers from a grant at the node itself, with no tree at all", async () => {
    const request = vi.fn().mockResolvedValue({
      items: [{ permission: "reports.view", nodes: ["frontend"] }],
    });
    const requestConditional = vi
      .fn()
      .mockResolvedValue({ modified: true, data: { items: [] }, etag: null });

    const authorizer = new LocalAuthorizer({
      request,
      requestConditional,
    } as unknown as CanopyClient);

    // A direct grant needs no lineage, so an unreadable hierarchy must not
    // turn it into an error either.
    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
    });
  });

  it("does not leave a listener on the caller's signal once it has answered", async () => {
    const { authorizer } = makeAuthorizer();
    const controller = new AbortController();

    // A signal that outlives one request — a per-request controller hides this,
    // but `evaluate` is public and a caller may pass any signal they like.
    for (let i = 0; i < 20; i++) {
      await authorizer.evaluate(check("frontend"), {
        signal: controller.signal,
      });
    }

    // `getEventListeners` reads an EventTarget's handlers directly. Without
    // cleanup this is 20 — one per call, all still attached.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("forgets everything on invalidate", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    authorizer.invalidate();

    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);
  });

  /**
   * The webhook shape: an assignment event names one identity, and only that
   * identity should pay a refetch — everyone else's grants and the hierarchy
   * stay warm.
   */
  it("forgets one identity on invalidate(identityId), keeping the rest", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    expect(request).toHaveBeenCalledTimes(2);

    authorizer.invalidate("id-1");

    // id-1 refetches; id-2 is still cached; the tree was never dropped.
    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(requestConditional).toHaveBeenCalledTimes(1);
  });

  it("does not drop the hierarchy on a per-identity invalidate", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    authorizer.invalidate("id-1");

    await authorizer.evaluate(check("frontend"));

    expect(requestConditional).toHaveBeenCalledTimes(1);
  });
});
