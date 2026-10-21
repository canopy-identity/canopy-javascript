import { describe, expect, it } from "vitest";

import { LocalAuthorizer } from "./authorizer.js";
import type { CanopyClient, RequestOptions } from "./client.js";

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

const PAGE_SIZE = 100;

/**
 * The id of node `index`, UUID-shaped like a real one and built afresh on
 * every call, so no id string exists until a page is asked for.
 */
function nodeId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/**
 * One page of the parent edges of a wide, shallow tree of `count` nodes, node
 * 0 the root and each node the parent of the next ten, as
 * `GET /api/v1/nodes/parents` answers it, parsed. Built and parsed on demand,
 * so nothing of it exists before the fetch and every id string is allocated
 * the way an HTTP response allocates it.
 */
function edgePage(count: number, page: number): unknown {
  const pageCount = Math.ceil(count / PAGE_SIZE);
  const items = [];

  for (
    let i = (page - 1) * PAGE_SIZE;
    i < Math.min(count, page * PAGE_SIZE);
    i++
  ) {
    items.push({
      id: nodeId(i),
      parent_node_id: i === 0 ? null : nodeId(Math.floor((i - 1) / 10)),
    });
  }

  return JSON.parse(
    JSON.stringify({
      model_version: 1,
      items,
      pagination: {
        page,
        take: PAGE_SIZE,
        item_count: count,
        page_count: pageCount,
        has_previous_page: page > 1,
        has_next_page: page < pageCount,
      },
    }),
  );
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
    const rootId = nodeId(0);
    // Asked about a node beneath the grant: a grant at the node itself is
    // answered without the tree, which would leave nothing to measure.
    const childId = nodeId(1);
    // Plain functions rather than mocks: a mock keeps every result it
    // returned, which would hold the parsed responses alive and count them.
    const client = {
      request: (_method: string, path: string, options: RequestOptions) =>
        Promise.resolve(
          path.endsWith("/grants")
            ? {
                model_version: 1,
                items: [{ permission: "report.view", node_id: rootId }],
                pagination: {
                  page: 1,
                  take: PAGE_SIZE,
                  item_count: 1,
                  page_count: 1,
                  has_previous_page: false,
                  has_next_page: false,
                },
              }
            : edgePage(NODES, Number(options.query?.["page"])),
        ),
      // A single page has nothing to confirm against, and a confirmation
      // answered 304 holds nothing: answer the first request in full and
      // every later one unchanged.
      requestConditional: (_method: string, _path: string, etag?: string) =>
        Promise.resolve(
          etag === undefined
            ? { modified: true, data: edgePage(NODES, 1), etag: '"tree-1"' }
            : { modified: false },
        ),
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
    expect(authorizer.snapshot()).toMatchObject({
      treeRequests: 1,
      // Every page of 100, and the request confirming the walk.
      treePages: NODES / PAGE_SIZE + 1,
    });
  });
});
