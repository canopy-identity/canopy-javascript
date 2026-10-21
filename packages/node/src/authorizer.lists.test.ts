import { describe, expect, it, vi } from "vitest";

import { LocalAuthorizer, type LocalDecisionEvent } from "./authorizer.js";
import type { CanopyClient } from "./client.js";
import { isCanopyAuthorizerError } from "./errors.js";

/**
 * The list side of the authorizer: where an identity may act, the
 * permissions it holds at a node, why a check was denied, the hooks that
 * hear each verdict, and a grant that ends on time rather than at the TTL.
 *
 *   root
 *    ├── engineering        ← reports.view granted here
 *    │    ├── frontend         inherits
 *    │    └── backend          inherits
 *    └── sales
 *         └── field          ← reports.edit granted here
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

const EDGES = [
  { id: "root", parent_node_id: null },
  { id: "engineering", parent_node_id: "root" },
  { id: "frontend", parent_node_id: "engineering" },
  { id: "backend", parent_node_id: "engineering" },
  { id: "sales", parent_node_id: "root" },
  { id: "field", parent_node_id: "sales" },
];

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

const page = <T>(items: T[]) => ({
  model_version: 1,
  items,
  pagination: meta(items.length),
});

interface GrantRow {
  permission: string;
  node_id: string;
  effective_from?: string | null;
  effective_to?: string | null;
}

const at = (days: number) => new Date(NOW + days * DAY).toISOString();

function makeAuthorizer(
  grants: GrantRow[],
  options: {
    edges?: typeof EDGES;
    ttlMs?: number;
    maxNodes?: number;
    onDecision?: (event: LocalDecisionEvent) => void;
    onDenied?: (event: LocalDecisionEvent) => void;
  } = {},
) {
  let clock = NOW;

  const request = vi.fn().mockResolvedValue(page(grants));
  const requestConditional = vi.fn().mockResolvedValue({
    modified: true,
    data: page(options.edges ?? EDGES),
    etag: 'W/"v1"',
  });

  const authorizer = new LocalAuthorizer(
    { request, requestConditional } as unknown as CanopyClient,
    {
      now: () => clock,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      ...(options.onDecision ? { onDecision: options.onDecision } : {}),
      ...(options.onDenied ? { onDenied: options.onDenied } : {}),
    },
  );

  return {
    authorizer,
    request,
    requestConditional,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const VIEW_AT_ENGINEERING = {
  permission: "reports.view",
  node_id: "engineering",
};
const EDIT_AT_FIELD = { permission: "reports.edit", node_id: "field" };

describe("LocalAuthorizer — where an identity may act", () => {
  it("names the minimal roots and expands them through their descendants", async () => {
    const { authorizer } = makeAuthorizer([
      VIEW_AT_ENGINEERING,
      // Beneath engineering, so engineering already covers it.
      { permission: "reports.view", node_id: "frontend" },
    ]);

    const roots = await authorizer.grantRoots("id-1", "reports.view");

    expect(roots).toEqual({ roots: ["engineering"], envWide: false });

    const set = await authorizer.accessibleNodes("id-1", "reports.view");

    expect(set.roots).toEqual(["engineering"]);
    expect(set.envWide).toBe(false);
    expect(set.complete).toBe(true);
    expect([...(set.nodes ?? [])].sort()).toEqual([
      "backend",
      "engineering",
      "frontend",
    ]);
  });

  it("answers envWide with no set when a root is the Environment's root", async () => {
    const { authorizer } = makeAuthorizer([
      { permission: "reports.view", node_id: "root" },
      VIEW_AT_ENGINEERING,
    ]);

    expect(await authorizer.grantRoots("id-1", "reports.view")).toEqual({
      roots: ["root"],
      envWide: true,
    });
    expect(await authorizer.accessibleNodes("id-1", "reports.view")).toEqual({
      roots: ["root"],
      envWide: true,
      nodes: null,
      complete: true,
    });
  });

  it("answers an empty set, without reading the tree, for a permission held nowhere", async () => {
    const { authorizer, requestConditional } = makeAuthorizer([
      VIEW_AT_ENGINEERING,
    ]);

    const set = await authorizer.accessibleNodes("id-1", "reports.edit");

    expect(set).toEqual({
      roots: [],
      envWide: false,
      nodes: new Set(),
      complete: true,
    });
    expect(requestConditional).not.toHaveBeenCalled();
  });

  it("withholds a set larger than the cap and says so, keeping the roots", async () => {
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING], {
      maxNodes: 2,
    });

    expect(await authorizer.accessibleNodes("id-1", "reports.view")).toEqual({
      roots: ["engineering"],
      envWide: false,
      nodes: null,
      complete: false,
    });

    // A call may raise the cap for itself.
    const raised = await authorizer.accessibleNodes("id-1", "reports.view", {
      maxNodes: 3,
    });

    expect(raised.complete).toBe(true);
    expect(raised.nodes?.size).toBe(3);
  });

  it("leaves out a root whose window is not in effect", async () => {
    const { authorizer } = makeAuthorizer([
      { ...VIEW_AT_ENGINEERING, effective_to: at(-1) },
      { permission: "reports.view", node_id: "sales", effective_from: at(2) },
      { permission: "reports.view", node_id: "field" },
    ]);

    expect(await authorizer.grantRoots("id-1", "reports.view")).toEqual({
      roots: ["field"],
      envWide: false,
    });
  });

  it("refuses to name roots the readable hierarchy does not contain", async () => {
    const { authorizer } = makeAuthorizer(
      [{ permission: "reports.view", node_id: "elsewhere" }],
      { edges: [] },
    );

    const error = await authorizer
      .grantRoots("id-1", "reports.view")
      .catch((e: unknown) => e);

    expect(isCanopyAuthorizerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "authorizer.hierarchy_incomplete",
    );
  });

  it("rejects a cap that is not a positive integer", () => {
    expect(
      () => new LocalAuthorizer({} as unknown as CanopyClient, { maxNodes: 0 }),
    ).toThrow(RangeError);
  });
});

describe("LocalAuthorizer — the permissions held at a node", () => {
  it("lists what grants on the lineage give, sorted", async () => {
    const { authorizer } = makeAuthorizer([
      VIEW_AT_ENGINEERING,
      EDIT_AT_FIELD,
      { permission: "reports.export", node_id: "root" },
    ]);

    expect(await authorizer.permissionsAt("id-1", "frontend")).toEqual([
      "reports.export",
      "reports.view",
    ]);
    expect(await authorizer.permissionsAt("id-1", "field")).toEqual([
      "reports.edit",
      "reports.export",
    ]);
    expect(await authorizer.permissionsAt("id-1", "sales")).toEqual([
      "reports.export",
    ]);
  });

  it("ignores a grant outside its window", async () => {
    const { authorizer } = makeAuthorizer([
      { ...VIEW_AT_ENGINEERING, effective_from: at(1) },
    ]);

    expect(await authorizer.permissionsAt("id-1", "frontend")).toEqual([]);
  });

  it("answers several nodes from one read of the grants", async () => {
    const { authorizer, request } = makeAuthorizer([
      VIEW_AT_ENGINEERING,
      EDIT_AT_FIELD,
    ]);

    const answers = await authorizer.permissionsAtMany("id-1", [
      "frontend",
      "field",
      "root",
      "frontend",
    ]);

    expect([...answers]).toEqual([
      ["frontend", ["reports.view"]],
      ["field", ["reports.edit"]],
      ["root", []],
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("LocalAuthorizer — why a check was denied", () => {
  it("says the permission is held nowhere", async () => {
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING]);

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.edit",
        node_id: "frontend",
      }),
    ).toEqual({ allowed: false, reason: "permission_not_held" });
  });

  it("says the node is outside the grants", async () => {
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING]);

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        node_id: "field",
      }),
    ).toEqual({ allowed: false, reason: "outside_grants" });
  });

  it("says a grant on the lineage has expired", async () => {
    const { authorizer } = makeAuthorizer([
      { ...VIEW_AT_ENGINEERING, effective_from: at(-3), effective_to: at(-1) },
    ]);

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        node_id: "frontend",
      }),
    ).toEqual({ allowed: false, reason: "expired" });
  });

  it("says a grant on the lineage has not begun", async () => {
    const { authorizer } = makeAuthorizer([
      { ...VIEW_AT_ENGINEERING, effective_from: at(1) },
    ]);

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        node_id: "frontend",
      }),
    ).toEqual({ allowed: false, reason: "not_yet_effective" });

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        scope: "app_wide",
      }),
    ).toEqual({ allowed: false, reason: "not_yet_effective" });
  });

  it("prefers a grant in effect over one that has ended on the same lineage", async () => {
    const { authorizer } = makeAuthorizer([
      { permission: "reports.view", node_id: "root", effective_to: at(-1) },
      VIEW_AT_ENGINEERING,
    ]);

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        node_id: "frontend",
      }),
    ).toEqual({ allowed: true, reason: null });
  });
});

describe("LocalAuthorizer — decision hooks", () => {
  it("tells both hooks about a denial, and only onDecision about an allow", async () => {
    const onDecision = vi.fn();
    const onDenied = vi.fn();
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING], {
      onDecision,
      onDenied,
    });

    const allow = {
      identity_id: "id-1",
      permission: "reports.view",
      node_id: "frontend",
    };
    const deny = { ...allow, node_id: "field" };

    await authorizer.evaluate(allow);
    await authorizer.evaluate(deny);

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision.mock.calls[0]?.[0]).toMatchObject({
      query: allow,
      decision: { allowed: true, reason: null },
    });
    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls[0]?.[0]).toMatchObject({
      query: deny,
      decision: { allowed: false, reason: "outside_grants" },
    });
    expect(
      typeof (onDenied.mock.calls[0]?.[0] as LocalDecisionEvent).durationMs,
    ).toBe("number");
  });

  it("keeps a hook's failure away from the verdict", async () => {
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING], {
      onDecision: () => {
        throw new Error("audit sink down");
      },
      onDenied: () => {
        throw new Error("pager down");
      },
    });

    expect(
      await authorizer.evaluate({
        identity_id: "id-1",
        permission: "reports.view",
        node_id: "field",
      }),
    ).toEqual({ allowed: false, reason: "outside_grants" });
  });

  it("fires the hook when a raced check settles too", async () => {
    const onDecision = vi.fn();
    const { authorizer } = makeAuthorizer([VIEW_AT_ENGINEERING], {
      onDecision,
    });

    await authorizer.evaluate(
      { identity_id: "id-1", permission: "reports.view", node_id: "frontend" },
      { signal: new AbortController().signal },
    );

    expect(onDecision).toHaveBeenCalledTimes(1);
  });
});

describe("LocalAuthorizer — a grant that ends before the TTL", () => {
  it("re-reads the grants at the window's boundary rather than waiting for the TTL", async () => {
    const { authorizer, request, advance } = makeAuthorizer(
      [{ ...VIEW_AT_ENGINEERING, effective_to: at(1) }],
      { ttlMs: 300_000 },
    );
    const query = {
      identity_id: "id-1",
      permission: "reports.view",
      node_id: "frontend",
    };

    expect(await authorizer.evaluate(query)).toMatchObject({ allowed: true });
    expect(request).toHaveBeenCalledTimes(1);

    // Well inside the TTL, before the boundary: still cached.
    advance(200_000);
    expect(await authorizer.evaluate(query)).toMatchObject({ allowed: true });
    expect(request).toHaveBeenCalledTimes(1);

    // Past the boundary: read again, and the grant has ended.
    advance(DAY);
    expect(await authorizer.evaluate(query)).toEqual({
      allowed: false,
      reason: "expired",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
