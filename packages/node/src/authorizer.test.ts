import { getEventListeners } from "node:events";

import { describe, expect, it, type Mock, vi } from "vitest";

import { LocalAuthorizer } from "./authorizer.js";
import { isCanopyAuthorizerError } from "./errors.js";
import type { CanopyClient } from "./client.js";

/** The `pagination` block of one page of `item_count` rows, 100 to a page. */
function meta(page: number, itemCount: number, take = 100) {
  const pageCount = Math.max(1, Math.ceil(itemCount / take));

  return {
    page,
    take,
    item_count: itemCount,
    page_count: pageCount,
    has_previous_page: page > 1,
    has_next_page: page < pageCount,
  };
}

/** `items` as the API pages them, 100 to a page by default. */
function paged<T>(items: T[], take = 100) {
  const pages: {
    model_version: number;
    items: T[];
    pagination: ReturnType<typeof meta>;
  }[] = [];

  for (let start = 0; start === 0 || start < items.length; start += take) {
    pages.push({
      model_version: 1,
      items: items.slice(start, start + take),
      pagination: meta(pages.length + 1, items.length, take),
    });
  }

  return pages;
}

/**
 *   root
 *    ├── engineering        ← the grant
 *    │    └── frontend          inherits
 *    └── sales                  does not
 *
 * As parent edges, which is what `GET /api/v1/nodes/parents` answers and all a
 * walk upward needs.
 */
const EDGES = [
  { id: "root", parent_node_id: null },
  { id: "engineering", parent_node_id: "root" },
  { id: "frontend", parent_node_id: "engineering" },
  { id: "sales", parent_node_id: "root" },
];

const TREE = {
  model_version: 1,
  items: EDGES,
  pagination: meta(1, EDGES.length),
};

/** One row per permission and node it was granted at. */
const GRANTS = {
  model_version: 1,
  items: [{ permission: "reports.view", node_id: "engineering" }],
  pagination: meta(1, 1),
};

const EMPTY_TREE = { model_version: 1, items: [], pagination: meta(1, 0) };

/** A client read: every one resolves, so an implementation returns a promise. */
type ReadMock = Mock<(...args: never[]) => Promise<unknown>>;

interface Harness {
  authorizer: LocalAuthorizer;
  request: ReadMock;
  requestConditional: ReadMock;
  advance: (ms: number) => void;
}

function makeAuthorizer(
  overrides: { grants?: unknown; ttlMs?: number } = {},
): Harness {
  let clock = 1_000;

  const request: ReadMock = vi
    .fn<(...args: never[]) => Promise<unknown>>()
    .mockResolvedValue(overrides.grants ?? GRANTS);

  const requestConditional: ReadMock = vi
    .fn<(...args: never[]) => Promise<unknown>>()
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
      reason: null,
    });
  });

  it("allows at a descendant, by walking up to the grant", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("denies on a different branch", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("sales"))).toEqual({
      allowed: false,
      reason: "outside_grants",
    });
  });

  it("denies above the grant, because inheritance runs down and not up", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("root"))).toEqual({
      allowed: false,
      reason: "outside_grants",
    });
  });

  it("denies a permission held nowhere without reading the tree", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "nothing.granted",
      node_id: "frontend",
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "permission_not_held",
    });
    expect(requestConditional).not.toHaveBeenCalled();
  });

  it("denies a node check that names no node", async () => {
    const { authorizer } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "reports.view",
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "node_missing",
    });
  });

  it("answers app_wide from the grants alone, with no tree", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    const decision = await authorizer.evaluate({
      identity_id: "id-1",
      permission: "reports.view",
      scope: "app_wide",
    });

    expect(decision).toEqual({
      allowed: true,
      reason: null,
    });
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

  /**
   * A cold start is a new instance: nothing a previous one held carries over,
   * even against the same client, so its first check pays for both reads.
   */
  it("starts a new instance empty, reading both the grants and the tree", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();
    const client = { request, requestConditional } as unknown as CanopyClient;

    await authorizer.evaluate(check("frontend"));

    const coldStart = new LocalAuthorizer(client);

    await coldStart.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);
    expect(requestConditional).toHaveBeenCalledTimes(2);
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
      reason: null,
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
      reason: null,
    });

    // Frontend leaves Engineering. The grant is untouched and still correct —
    // which is exactly why refreshing only the grants would keep allowing it.
    requestConditional.mockResolvedValue({
      modified: true,
      etag: 'W/"v2"',
      data: {
        model_version: 1,
        items: [
          { id: "root", parent_node_id: null },
          { id: "engineering", parent_node_id: "root" },
          { id: "sales", parent_node_id: "root" },
          { id: "frontend", parent_node_id: "sales" },
        ],
        pagination: meta(1, 4),
      },
    });

    advance(61_000);

    expect(await authorizer.evaluate(check("frontend"))).toMatchObject({
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
      grantPages: 2,
      treeRequests: 2,
      treePages: 2,
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
      query: { page: 1, take: 100, include: "windows" },
    });

    expect(requestConditional.mock.calls[0]?.[3]).toEqual({
      timeoutMs: 750,
      maxRetries: 0,
      maxBackoffMs: 750,
      query: { page: 1, take: 100 },
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

    expect(await theirs).toEqual({
      allowed: true,
      reason: null,
    });
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
  it.each([300_001, 3_600_000, -1, Number.NaN])(
    "refuses a window of %s, which would stretch how long a revoked user keeps access",
    (ttlMs) => {
      expect(() => makeAuthorizer({ ttlMs })).toThrow(RangeError);
    },
  );

  it("accepts a window of exactly five minutes", () => {
    expect(() => makeAuthorizer({ ttlMs: 300_000 })).not.toThrow();
  });

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
   * `GET /api/v1/nodes/parents` answers a hierarchy scoped to the caller,
   * and a credential without `hierarchy.view` gets an empty one — with a
   * `200`, so nothing looks broken. Walking off that map would answer `false` on every node-scoped
   * route: a silent, total denial that reads as ordinary policy.
   */
  it("refuses to decide when the tree does not contain the node", async () => {
    const request = vi.fn().mockResolvedValue(GRANTS);
    const requestConditional = vi
      .fn()
      .mockResolvedValue({ modified: true, data: EMPTY_TREE, etag: null });

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
      model_version: 1,
      items: [{ permission: "reports.view", node_id: "frontend" }],
      pagination: meta(1, 1),
    });
    const requestConditional = vi
      .fn()
      .mockResolvedValue({ modified: true, data: EMPTY_TREE, etag: null });

    const authorizer = new LocalAuthorizer({
      request,
      requestConditional,
    } as unknown as CanopyClient);

    // A direct grant needs no lineage, so an unreadable hierarchy must not
    // turn it into an error either.
    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
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

  /**
   * Two instances stand in for two server processes behind a load balancer:
   * an invalidation lands on one, and the other keeps its cached answer until
   * its own window lapses.
   */
  it("invalidates only its own instance, leaving another's cache warm", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();
    const client = { request, requestConditional } as unknown as CanopyClient;
    const otherInstance = new LocalAuthorizer(client);

    await authorizer.evaluate(check("frontend"));
    await otherInstance.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);

    authorizer.invalidate();

    await otherInstance.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);

    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not drop the hierarchy on a per-identity invalidate", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    authorizer.invalidate("id-1");

    await authorizer.evaluate(check("frontend"));

    expect(requestConditional).toHaveBeenCalledTimes(1);
  });
});

/**
 * A fake Canopy that pages both reads the way the API does: grants by
 * `page`/`take` on `request`, the hierarchy's first page on
 * `requestConditional` and every later page on `request`.
 */
function pagedCanopy(options: {
  grants: { permission: string; node_id: string }[];
  /** One entry per hierarchy version; `etag` names it. */
  trees: {
    etag: string;
    edges: { id: string; parent_node_id: string | null }[];
  }[];
  take?: number;
  /** Called after each later page of the hierarchy is served. */
  onTreePage?: (page: number) => void;
}) {
  const take = options.take ?? 100;
  let version = 0;

  const treePage = (page: number) =>
    paged(options.trees[version]?.edges ?? [], take)[page - 1];

  const request = vi.fn(
    (_method: string, path: string, opts: { query: { page: number } }) => {
      if (path.endsWith("/grants")) {
        return Promise.resolve(
          paged(options.grants, take)[opts.query.page - 1],
        );
      }

      const page = treePage(opts.query.page);

      options.onTreePage?.(opts.query.page);

      return Promise.resolve(page);
    },
  );

  const requestConditional = vi.fn(
    (_method: string, _path: string, etag: string | undefined) => {
      const current = options.trees[version];

      if (etag !== undefined && etag === current?.etag) {
        return Promise.resolve({ modified: false });
      }

      return Promise.resolve({
        modified: true,
        data: treePage(1),
        etag: current?.etag ?? null,
      });
    },
  );

  return {
    client: { request, requestConditional } as unknown as CanopyClient,
    request,
    requestConditional,
    /** Moves the hierarchy to the next version. */
    change: () => {
      version += 1;
    },
  };
}

describe("LocalAuthorizer — paged reads", () => {
  it("reads every page of grant roots and joins a permission's nodes", async () => {
    // 150 rows over two pages; the permission under test is granted at a node
    // on each, and a second permission appears only on the second.
    const filler = Array.from({ length: 148 }, (_, i) => ({
      permission: "audit.view",
      node_id: `n${String(i).padStart(3, "0")}`,
    }));
    const { client, request } = pagedCanopy({
      grants: [
        { permission: "reports.view", node_id: "engineering" },
        ...filler,
        { permission: "reports.view", node_id: "sales" },
      ],
      trees: [{ etag: 'W/"v1"', edges: EDGES }],
    });
    const authorizer = new LocalAuthorizer(client);

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(await authorizer.evaluate(check("sales"))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(await authorizer.evaluate(check("root"))).toMatchObject({
      allowed: false,
    });

    const grantPages = request.mock.calls.filter(([, path]) =>
      path.endsWith("/grants"),
    );

    expect(grantPages.map(([, , opts]) => opts.query)).toEqual([
      { page: 1, take: 100, include: "windows" },
      { page: 2, take: 100, include: "windows" },
    ]);
    expect(authorizer.snapshot()).toMatchObject({
      grantFetches: 1,
      grantPages: 2,
    });
  });

  it("walks every page of the hierarchy, a child's parent arriving on a later page", async () => {
    // Two to a page: `frontend` is on the first page, its parent
    // `engineering` on the second and the root on the third.
    const { client, request, requestConditional } = pagedCanopy({
      grants: [{ permission: "reports.view", node_id: "root" }],
      trees: [
        {
          etag: 'W/"v1"',
          edges: [
            { id: "frontend", parent_node_id: "engineering" },
            { id: "sales", parent_node_id: "root" },
            { id: "engineering", parent_node_id: "root" },
            { id: "x-ray", parent_node_id: "sales" },
            { id: "root", parent_node_id: null },
          ],
        },
      ],
      take: 2,
    });
    const authorizer = new LocalAuthorizer(client);

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });

    const treePages = request.mock.calls.filter(
      ([, path]) => path === "/api/v1/nodes/parents",
    );

    expect(treePages.map(([, , opts]) => opts.query)).toEqual([
      { page: 2, take: 100 },
      { page: 3, take: 100 },
    ]);

    // Page 1, then confirming the walk with the validator page 1 came with.
    expect(requestConditional.mock.calls.map(([, , etag]) => etag)).toEqual([
      undefined,
      'W/"v1"',
    ]);
    expect(authorizer.snapshot()).toMatchObject({
      treeRequests: 1,
      treePages: 4,
      treeNotModified: 0,
    });
  });

  it("keeps the whole paged hierarchy on a 304 to its first page", async () => {
    let clock = 1_000;
    const { client, request, requestConditional } = pagedCanopy({
      grants: [{ permission: "reports.view", node_id: "engineering" }],
      trees: [{ etag: 'W/"v1"', edges: EDGES }],
      take: 2,
    });
    const authorizer = new LocalAuthorizer(client, {
      ttlMs: 60_000,
      now: () => clock,
    });

    await authorizer.evaluate(check("frontend"));

    const before = request.mock.calls.length;

    clock += 61_000;

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });

    // The revalidation is one conditional request for page 1, answered 304:
    // no later page is read.
    expect(requestConditional).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/nodes/parents",
      'W/"v1"',
      expect.objectContaining({ query: { page: 1, take: 100 } }),
    );
    expect(
      request.mock.calls
        .slice(before)
        .filter(([, path]) => path === "/api/v1/nodes/parents"),
    ).toHaveLength(0);
    expect(authorizer.snapshot()).toMatchObject({
      treeRequests: 2,
      treePages: 4,
      treeNotModified: 1,
    });
  });

  it("walks again when the hierarchy changed while its pages were read", async () => {
    // `frontend` moves from Engineering to Sales after the first page is
    // read; the confirmation sees the new version and the walk restarts.
    const moved = EDGES.map((edge) =>
      edge.id === "frontend" ? { ...edge, parent_node_id: "sales" } : edge,
    );
    let changed = false;
    const canopy = pagedCanopy({
      grants: [{ permission: "reports.view", node_id: "engineering" }],
      trees: [
        { etag: 'W/"v1"', edges: EDGES },
        { etag: 'W/"v2"', edges: moved },
      ],
      take: 2,
      onTreePage: () => {
        if (!changed) {
          changed = true;
          canopy.change();
        }
      },
    });

    const authorizer = new LocalAuthorizer(canopy.client);

    expect(await authorizer.evaluate(check("frontend"))).toMatchObject({
      allowed: false,
    });
    expect(
      canopy.requestConditional.mock.calls.map(([, , etag]) => etag),
    ).toEqual([undefined, 'W/"v1"', 'W/"v2"']);
  });

  it("keeps a hierarchy it could not confirm without a validator, so the next refresh rereads it", async () => {
    let clock = 1_000;
    const request = vi.fn(
      (_method: string, path: string, opts: { query: { page: number } }) =>
        Promise.resolve(
          path.endsWith("/grants")
            ? GRANTS
            : paged(EDGES, 2)[opts.query.page - 1],
        ),
    );
    // Every first page is a new version: the hierarchy never holds still.
    let version = 0;
    const requestConditional = vi.fn(
      (_method: string, _path: string, _etag?: string) => {
        version += 1;

        return Promise.resolve({
          modified: true,
          data: paged(EDGES, 2)[0],
          etag: `W/"v${version}"`,
        });
      },
    );
    const authorizer = new LocalAuthorizer(
      { request, requestConditional } as unknown as CanopyClient,
      { ttlMs: 60_000, now: () => clock },
    );

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });

    // Three walks, each confirmed against the next version.
    expect(requestConditional.mock.calls.map((call) => call[2])).toEqual([
      undefined,
      'W/"v1"',
      'W/"v2"',
      'W/"v3"',
    ]);

    clock += 61_000;
    await authorizer.evaluate(check("frontend"));

    expect(requestConditional.mock.calls[4]?.[2]).toBeUndefined();
  });
});

/**
 * A machine client holds roles of its own, read from its own grants. The two
 * kinds never share a cache entry, so a client whose `client_id` happened to
 * equal an identity's id could not borrow that person's answer.
 */
describe("LocalAuthorizer — machine clients", () => {
  const serviceCheck = (nodeId: string) => ({
    ...check(nodeId),
    principal_type: "service" as const,
  });

  it("reads a machine client's grants from the client's own path", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(serviceCheck("frontend"));

    expect(request.mock.calls[0]?.[1]).toBe(
      "/api/v1/oauth-clients/id-1/grants",
    );
  });

  it("reads an identity's grants from the identity path by default", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    expect(request.mock.calls[0]?.[1]).toBe("/api/v1/identities/id-1/grants");
  });

  it("caches a client and an identity with the same id apart", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate(serviceCheck("frontend"));
    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate(serviceCheck("frontend"));

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forgets only the kind named on invalidate", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate(serviceCheck("frontend"));

    authorizer.invalidate("id-1", { principalType: "service" });

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate(serviceCheck("frontend"));

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toBe(
      "/api/v1/oauth-clients/id-1/grants",
    );
  });

  it("answers the list reads for a machine client from its grants", async () => {
    const { authorizer, request } = makeAuthorizer();

    expect(
      await authorizer.permissionsAt("id-1", "frontend", {
        principalType: "service",
      }),
    ).toEqual(["reports.view"]);
    expect(request.mock.calls[0]?.[1]).toBe(
      "/api/v1/oauth-clients/id-1/grants",
    );
  });
});

/** A version 2 grants page: the rows, with the subject's deny roots beside them. */
function withDenies(
  items: { permission: string; node_id: string }[],
  denies: { permission: string; node_id: string }[],
  pagination = meta(1, items.length),
) {
  return {
    model_version: 2,
    items,
    pagination,
    denies: denies.map((deny, index) => ({
      ...deny,
      deny_id: `deny-${index}`,
    })),
  };
}

describe("LocalAuthorizer — denies", () => {
  it("refuses beneath a deny root even with a grant at the node itself", async () => {
    const { authorizer, requestConditional } = makeAuthorizer({
      grants: withDenies(
        [{ permission: "reports.view", node_id: "frontend" }],
        [{ permission: "reports.view", node_id: "engineering" }],
      ),
    });

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: false,
      reason: "denied",
    });
    // A direct grant normally needs no tree; a deny on the permission does.
    expect(requestConditional).toHaveBeenCalled();
  });

  it("says denied rather than not held beneath a deny, and only there", async () => {
    const { authorizer } = makeAuthorizer({
      grants: withDenies(
        [],
        [{ permission: "reports.view", node_id: "engineering" }],
      ),
    });

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(await authorizer.evaluate(check("sales"))).toEqual({
      allowed: false,
      reason: "permission_not_held",
    });
  });

  it("leaves other permissions to their grants", async () => {
    const { authorizer } = makeAuthorizer({
      grants: withDenies(
        [{ permission: "reports.view", node_id: "engineering" }],
        [{ permission: "reports.edit", node_id: "root" }],
      ),
    });

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("gathers the deny roots from every page of grants", async () => {
    const { authorizer, request } = makeAuthorizer();
    const rows = [
      { permission: "reports.view", node_id: "engineering" },
      { permission: "reports.edit", node_id: "engineering" },
    ];

    request
      .mockResolvedValueOnce(withDenies([rows[0]!], [], meta(1, 2, 1)))
      .mockResolvedValueOnce(
        withDenies(
          [rows[1]!],
          [{ permission: "reports.view", node_id: "frontend" }],
          meta(2, 2, 1),
        ),
      );

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(await authorizer.evaluate(check("engineering"))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("holds a permission anywhere while one grant stands clear of every deny", async () => {
    const above = makeAuthorizer({
      grants: withDenies(
        [{ permission: "reports.view", node_id: "engineering" }],
        [{ permission: "reports.view", node_id: "root" }],
      ),
    });
    const beneath = makeAuthorizer({
      grants: withDenies(
        [{ permission: "reports.view", node_id: "engineering" }],
        [{ permission: "reports.view", node_id: "frontend" }],
      ),
    });
    const appWide = {
      identity_id: "id-1",
      permission: "reports.view",
      scope: "app_wide" as const,
    };

    expect(await above.authorizer.evaluate(appWide)).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(await beneath.authorizer.evaluate(appWide)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("cuts a denied subtree out of an Environment-wide grant", async () => {
    const { authorizer } = makeAuthorizer({
      grants: withDenies(
        [{ permission: "reports.view", node_id: "root" }],
        [{ permission: "reports.view", node_id: "engineering" }],
      ),
    });

    const set = await authorizer.accessibleNodes("id-1", "reports.view");

    expect({ ...set, nodes: [...(set.nodes ?? [])].sort() }).toEqual({
      roots: ["root"],
      excludedRoots: ["engineering"],
      envWide: false,
      nodes: ["root", "sales"],
      complete: true,
    });
    expect(await authorizer.permissionsAt("id-1", "frontend")).toEqual([]);
    expect(await authorizer.permissionsAt("id-1", "sales")).toEqual([
      "reports.view",
    ]);
  });

  it("reads a version 1 answer, which carries no denies, as none", async () => {
    const { authorizer } = makeAuthorizer();

    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

/** A delivery as the API sends it, with only what the cache reads. */
function delivery(
  event: string,
  metadata: Record<string, unknown> = {},
  resource: { type?: string; id?: string } = {},
) {
  return {
    event,
    data: {
      resource_type: resource.type ?? null,
      resource_id: resource.id ?? null,
      metadata,
    },
  };
}

const NO_GRANTS = { model_version: 1, items: [], pagination: meta(1, 0) };

describe("LocalAuthorizer — applying changes", () => {
  /**
   * The point of the whole surface: a revocation delivered as a webhook
   * reaches the next local decision now, not when the window lapses.
   */
  it("denies on the next check after an assignment.removed, inside the window", async () => {
    const { authorizer, request } = makeAuthorizer();

    expect((await authorizer.evaluate(check("frontend"))).allowed).toBe(true);

    request.mockResolvedValue(NO_GRANTS);

    const applied = authorizer.applyEvent(
      delivery("assignment.removed", {
        identity_id: "id-1",
        oauth_client_id: null,
        client_id: null,
        node_id: "engineering",
        role_id: "role-1",
      }),
    );

    expect(applied).toEqual({
      event: "assignment.removed",
      invalidated: "subjects",
      subjects: [{ principalType: "identity", id: "id-1" }],
    });
    expect(await authorizer.evaluate(check("frontend"))).toEqual({
      allowed: false,
      reason: "permission_not_held",
    });
  });

  it("keeps everyone else's grants and the hierarchy for a change naming one person", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    authorizer.applyEvent(
      delivery("organization.member.removed", { identity_id: "id-1" }),
    );

    await authorizer.evaluate(check("frontend"));
    await authorizer.evaluate({ ...check("frontend"), identity_id: "id-2" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(requestConditional).toHaveBeenCalledTimes(1);
  });

  it("drops everything for a change whose reach it cannot name", async () => {
    const { authorizer, request, requestConditional } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    expect(authorizer.applyEvent(delivery("role.permissions.updated"))).toEqual(
      { event: "role.permissions.updated", invalidated: "all" },
    );

    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(2);
    expect(requestConditional).toHaveBeenCalledTimes(2);
  });

  it("drops nothing for a change that moves no one's access", async () => {
    const { authorizer, request } = makeAuthorizer();

    await authorizer.evaluate(check("frontend"));

    expect(authorizer.applyEvent(delivery("identity.updated"))).toEqual({
      event: "identity.updated",
      invalidated: "none",
    });

    await authorizer.evaluate(check("frontend"));

    expect(request).toHaveBeenCalledTimes(1);
  });

  /**
   * The race a webhook-driven cache has to close: a read that began before
   * the change finishes after it. Kept, it would put the revoked access back
   * for a whole window.
   */
  it("does not keep a grant read that was in flight when its subject was invalidated", async () => {
    const { authorizer, request } = makeAuthorizer();
    let finish: (value: unknown) => void = () => undefined;

    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const inFlight = authorizer.evaluate(check("frontend"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    authorizer.applyEvent(
      delivery("assignment.removed", { identity_id: "id-1" }),
    );
    request.mockResolvedValue(NO_GRANTS);
    finish(GRANTS);

    // The check that started before the change answers from what it read.
    expect((await inFlight).allowed).toBe(true);
    // The next one reads again and sees the revocation.
    expect((await authorizer.evaluate(check("frontend"))).allowed).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not keep a hierarchy read that was in flight when everything was invalidated", async () => {
    const { authorizer, requestConditional } = makeAuthorizer();
    let finish: (value: unknown) => void = () => undefined;

    requestConditional.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const inFlight = authorizer.evaluate(check("frontend"));

    await vi.waitFor(() => expect(requestConditional).toHaveBeenCalledTimes(1));

    authorizer.applyEvent(delivery("node.moved"));
    finish({ modified: true, data: TREE, etag: 'W/"v1"' });

    await inFlight;
    await authorizer.evaluate(check("frontend"));

    expect(requestConditional).toHaveBeenCalledTimes(2);
  });
});

describe("LocalAuthorizer — replaying the change feed", () => {
  /** A change feed of `events`, served `limit` to a page as the API does. */
  function changeFeed(events: ReturnType<typeof delivery>[]) {
    return (
      _method: string,
      path: string,
      options: { query?: Record<string, unknown> },
    ) => {
      if (path !== "/api/v1/changes") {
        return Promise.resolve(GRANTS);
      }

      const limit = Number(options.query?.["limit"]);
      const cursor = options.query?.["cursor"];
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = events
        .slice(start, start + limit)
        .map((event, i) => ({ id: `c${start + i}`, ...event }));
      const end = start + items.length;

      return Promise.resolve({
        items,
        pagination: {
          next_cursor:
            items.length > 0
              ? String(end)
              : ((cursor as string | undefined) ?? null),
        },
      });
    };
  }

  it("applies every change after the cursor and answers where it stopped", async () => {
    const { authorizer, request } = makeAuthorizer();

    request.mockImplementation(
      changeFeed([
        delivery("identity.updated"),
        delivery("assignment.removed", { identity_id: "id-1" }),
        delivery("organization.member.removed", { identity_id: "id-2" }),
      ]),
    );

    const result = await authorizer.replayChanges({ cursor: "1" });

    expect(result).toEqual({
      cursor: "3",
      changes: 2,
      invalidatedAll: false,
      subjectsInvalidated: 2,
    });
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/changes",
      expect.objectContaining({ query: { limit: 200, cursor: "1" } }),
    );
  });

  it("reads page after page until it reaches the newest change", async () => {
    const { authorizer, request } = makeAuthorizer();
    const events = Array.from({ length: 450 }, () =>
      delivery("assignment.removed", { identity_id: "id-1" }),
    );

    request.mockImplementation(changeFeed(events));

    const result = await authorizer.replayChanges();

    expect(result.cursor).toBe("450");
    expect(result.changes).toBe(450);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("drops a cached answer a replayed change revoked", async () => {
    const { authorizer, request } = makeAuthorizer();

    expect((await authorizer.evaluate(check("frontend"))).allowed).toBe(true);

    const feed = changeFeed([delivery("role.permissions.updated")]);

    request.mockImplementation(
      (
        method: string,
        path: string,
        options: { query?: Record<string, unknown> },
      ) =>
        path === "/api/v1/changes"
          ? feed(method, path, options)
          : Promise.resolve(NO_GRANTS),
    );

    const result = await authorizer.replayChanges();

    expect(result.invalidatedAll).toBe(true);
    expect((await authorizer.evaluate(check("frontend"))).allowed).toBe(false);
  });

  it("keeps the cursor it was given when nothing is newer", async () => {
    const { authorizer, request } = makeAuthorizer();

    request.mockImplementation(changeFeed([delivery("identity.updated")]));

    const result = await authorizer.replayChanges({ cursor: "1" });

    expect(result).toEqual({
      cursor: "1",
      changes: 0,
      invalidatedAll: false,
      subjectsInvalidated: 0,
    });
  });

  it("answers a null cursor for a feed that has never held a change", async () => {
    const { authorizer, request } = makeAuthorizer();

    request.mockImplementation(changeFeed([]));

    expect((await authorizer.replayChanges()).cursor).toBeNull();
  });
});
