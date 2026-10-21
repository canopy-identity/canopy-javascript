import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { LocalAuthorizer } from "./authorizer.js";
import type { CanopyClient } from "./client.js";
import { CanopyError, isCanopyAuthorizerError } from "./errors.js";

/**
 * Canopy's authorization conformance vectors, replayed through the local
 * authorizer.
 *
 * Canopy publishes the vectors at `/conformance/authorization.json` and its
 * own suite replays them against the API end to end: the tree, each
 * identity's grant roots, and every `evaluate` answer. This replays the same
 * file from the other side. The authorizer is handed exactly what the vector
 * says the API serves (the grant roots, the parent edges) and must reach the
 * `allowed` the API reaches. `npm run generate` refreshes the file;
 * `generate:check` fails when Canopy has published new rules.
 */

interface Vector {
  name: string;
  tree: Array<{ id: string; parent: string | null }>;
  grants: Record<string, Array<{ permission: string; node: string }> | null>;
  checks: Array<{
    identity: string;
    permission: string;
    scope: "node" | "app_wide";
    node?: string;
    allowed: boolean;
  }>;
}

const CONFORMANCE = JSON.parse(
  readFileSync(
    new URL("./generated/conformance.json", import.meta.url),
    "utf-8",
  ),
) as { model_version: number; vectors: Vector[] };

const page = <T>(items: T[]) => ({
  model_version: CONFORMANCE.model_version,
  items,
  pagination: {
    page: 1,
    take: 100,
    item_count: items.length,
    page_count: 1,
    has_previous_page: false,
    has_next_page: false,
  },
});

/** An authorizer whose Canopy serves what the vector says the API serves. */
function authorizerFor(vector: Vector): LocalAuthorizer {
  const request = vi.fn((_method: string, path: string) => {
    const identity = decodeURIComponent(
      /\/identities\/([^/]+)\/grants$/.exec(path)?.[1] ?? "",
    );
    const roots = vector.grants[identity];

    if (roots === null || roots === undefined) {
      return Promise.reject(
        new CanopyError(
          {
            statusCode: 404,
            code: "identity.not_found",
            message: "Identity not found",
          },
          { method: "GET", path },
        ),
      );
    }

    return Promise.resolve(
      page(
        roots.map((root) => ({
          permission: root.permission,
          node_id: root.node,
        })),
      ),
    );
  });

  const requestConditional = vi.fn().mockResolvedValue({
    modified: true,
    etag: null,
    data: page(
      vector.tree.map((node) => ({ id: node.id, parent_node_id: node.parent })),
    ),
  });

  return new LocalAuthorizer({
    request,
    requestConditional,
  } as unknown as CanopyClient);
}

/**
 * What a guard does with the answer: an identity Canopy does not know is a
 * deny, which is how `@canopy-io/nestjs` treats `identity.not_found`.
 */
async function allowed(
  authorizer: LocalAuthorizer,
  check: Vector["checks"][number],
): Promise<boolean> {
  try {
    const answer = await authorizer.evaluate({
      identity_id: check.identity,
      permission: check.permission,
      scope: check.scope,
      ...(check.node ? { node_id: check.node } : {}),
    });

    return answer.allowed;
  } catch (error) {
    if (error instanceof CanopyError && error.code === "identity.not_found") {
      return false;
    }

    throw error;
  }
}

describe("LocalAuthorizer — Canopy's conformance vectors", () => {
  it("replays the model version this package understands", () => {
    expect(CONFORMANCE.model_version).toBe(1);
    expect(CONFORMANCE.vectors.length).toBeGreaterThan(0);
  });

  describe.each(CONFORMANCE.vectors.map((vector) => [vector.name, vector]))(
    "%s",
    (_name, vector) => {
      it.each(
        vector.checks.map((check) => [
          `${check.identity} ${check.permission} ${check.scope}${check.node ? ` at ${check.node}` : ""}`,
          check,
        ]),
      )("%s", async (_label, check) => {
        expect(await allowed(authorizerFor(vector), check)).toBe(check.allowed);
      });
    },
  );
});

describe("LocalAuthorizer — the model version", () => {
  // The first test above fails first if there is none.
  const vector = CONFORMANCE.vectors[0] as Vector;
  const check = vector.checks.find((c) => c.scope === "node" && c.allowed);

  it("refuses grant roots that describe a model it does not know", async () => {
    const authorizer = new LocalAuthorizer({
      request: vi.fn().mockResolvedValue({ ...page([]), model_version: 99 }),
      requestConditional: vi.fn(),
    } as unknown as CanopyClient);

    const error = await authorizer
      .evaluate({
        identity_id: "anyone",
        permission: "reports.view",
        node_id: "root",
      })
      .catch((e: unknown) => e);

    expect(isCanopyAuthorizerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "authorizer.model_version_unknown",
    );
  });

  it("refuses a tree that describes a model it does not know", async () => {
    if (!check?.node) {
      throw new Error("the first vector needs a node-scoped allow");
    }

    const roots = vector.grants[check.identity] ?? [];
    const authorizer = new LocalAuthorizer({
      request: vi
        .fn()
        .mockResolvedValue(
          page(
            roots.map((r) => ({ permission: r.permission, node_id: r.node })),
          ),
        ),
      requestConditional: vi.fn().mockResolvedValue({
        modified: true,
        etag: null,
        data: {
          ...page(
            vector.tree.map((n) => ({ id: n.id, parent_node_id: n.parent })),
          ),
          model_version: 99,
        },
      }),
    } as unknown as CanopyClient);

    // A grant at a node beneath the root's, so the answer needs the tree.
    const deeper = vector.tree.find(
      (node) =>
        node.parent !== null &&
        !roots.some(
          (r) => r.permission === check.permission && r.node === node.id,
        ),
    );

    const error = await authorizer
      .evaluate({
        identity_id: check.identity,
        permission: check.permission,
        node_id: deeper?.id ?? check.node,
      })
      .catch((e: unknown) => e);

    expect(isCanopyAuthorizerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "authorizer.model_version_unknown",
    );
  });
});
