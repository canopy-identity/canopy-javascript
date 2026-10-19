import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LocalAuthorizer } from "./authorizer.js";
import type { CanopyClient } from "./client.js";

/**
 * What the authorizer's copy of the hierarchy costs in memory, the figure the
 * Canopy docs give a developer sizing a server ("Authorization caching").
 *
 * Run apart from the unit tests (`npm run test:memory`): it needs Node's
 * `--expose-gc` to measure a settled heap, and a heap figure wobbles a little
 * from run to run, which a fast suite should not have to absorb. CI runs it as
 * its own step, so a change that bloats the cache fails the pull request.
 */

const NODES = 50_000;

/**
 * Parent edges for a wide, shallow tree of `count` nodes under `rootId`, its
 * first child `childId`, as
 * the JSON text `GET /api/v1/nodes/parents` answers with, parsed. Built and
 * parsed on demand, so nothing of it exists before the fetch and every id
 * string is allocated the way an HTTP response allocates it.
 */
function parentEdges(rootId: string, childId: string, count: number): unknown {
  const ids = [
    rootId,
    childId,
    ...Array.from({ length: count - 2 }, () => randomUUID()),
  ];
  const items = ids.map((id, i) => ({
    id,
    parent_node_id: i === 0 ? null : ids[Math.floor((i - 1) / 10)],
  }));

  return JSON.parse(JSON.stringify({ items }));
}

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;

  if (!gc) {
    throw new Error("run with --expose-gc: npm run test:memory");
  }

  gc();
  gc();

  return process.memoryUsage().heapUsed;
}

describe("LocalAuthorizer memory", () => {
  it("holds the hierarchy at about 90 bytes per node, one id string each", async () => {
    const rootId = randomUUID();
    // Asked about a node beneath the grant: a grant at the node itself is
    // answered without the tree, which would leave nothing to measure.
    const childId = randomUUID();
    // Plain functions rather than mocks: a mock keeps every result it
    // returned, which would hold the parsed response alive and count it.
    const client = {
      request: () =>
        Promise.resolve({
          items: [{ permission: "report.view", nodes: [rootId] }],
        }),
      requestConditional: () =>
        Promise.resolve({
          modified: true,
          data: parentEdges(rootId, childId, NODES),
          etag: '"tree-1"',
        }),
    } as unknown as CanopyClient;
    const authorizer = new LocalAuthorizer(client);

    const before = heapUsed();

    await authorizer.evaluate({
      identity_id: "id-1",
      permission: "report.view",
      scope: "node",
      node_id: childId,
    });

    const perNode = (heapUsed() - before) / NODES;

    // The docs state about 90 bytes per node, 4.6 MB for 50,000: one id string
    // and one map entry. The range absorbs run-to-run noise and fails a
    // change that stores each id twice again (about 150).
    expect(perNode).toBeGreaterThan(60);
    expect(perNode).toBeLessThan(120);
    expect(authorizer.snapshot().treeRequests).toBe(1);
  });
});
