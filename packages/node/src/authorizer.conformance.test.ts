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
 * identity's grant roots with their windows, the accessible sets, the
 * permissions at a node, and every `evaluate` answer. This replays the same
 * file from the other side. The authorizer is handed exactly what the vector
 * says the API serves (the windowed grant roots, the parent edges) and must
 * reach the same `allowed`, the local reason, the same sets and the same
 * per-node permissions. A machine client's checks are replayed as a service
 * token's, so its grants must be read from the client's own endpoint. `npm run generate` refreshes the file;
 * `generate:check` fails when Canopy has published new rules.
 */

interface Vector {
  name: string;
  tree: Array<{ id: string; parent: string | null }>;
  machine_clients?: Array<{ id: string; organization?: string }>;
  grants: Record<string, Array<{ permission: string; node: string }> | null>;
  grant_windows: Record<
    string,
    Array<{
      permission: string;
      node: string;
      from_days?: number;
      to_days?: number;
    }> | null
  >;
  accessible: Array<{
    identity: string;
    permission: string;
    env_wide: boolean;
    roots: string[];
    nodes: string[] | null;
  }>;
  /** Where a permission is held at or beneath a node; absent on older vectors. */
  holds_anywhere_under?: Array<{
    identity: string;
    permission: string;
    subtree_root: string;
    held: boolean;
    roots: string[];
  }>;
  permissions_at: Array<{
    identity: string;
    node: string;
    permissions: string[];
  }>;
  checks: Array<{
    identity: string;
    permission: string;
    scope: "node" | "app_wide";
    node?: string;
    allowed: boolean;
    sdk_reason: string | null;
  }>;
  machine_client_checks?: Array<{
    machine_client: string;
    permission: string;
    scope: "node" | "app_wide";
    node?: string;
    allowed: boolean;
    sdk_reason: string | null;
  }>;
}

const CONFORMANCE = JSON.parse(
  readFileSync(
    new URL("./generated/conformance.json", import.meta.url),
    "utf-8",
  ),
) as { model_version: number; vectors: Vector[] };

/** The replay's clock: the vectors write their windows in days from it. */
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const at = (days: number | undefined): string | null =>
  days === undefined ? null : new Date(NOW + days * DAY).toISOString();

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

/**
 * An authorizer whose Canopy serves what the vector says the API serves. Each
 * endpoint knows only its own kind of holder: an identity read for a machine
 * client's name, or the reverse, answers `404` as the API would.
 */
function authorizerFor(vector: Vector): LocalAuthorizer {
  const clients = new Set((vector.machine_clients ?? []).map((c) => c.id));

  const request = vi.fn((_method: string, path: string) => {
    const [, kind, encoded] =
      /\/(identities|oauth-clients)\/([^/]+)\/grants$/.exec(path) ?? [];
    const holder = decodeURIComponent(encoded ?? "");
    const roots =
      (kind === "oauth-clients") === clients.has(holder)
        ? vector.grant_windows[holder]
        : undefined;

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
          effective_from: at(root.from_days),
          effective_to: at(root.to_days),
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

  return new LocalAuthorizer(
    { request, requestConditional } as unknown as CanopyClient,
    { now: () => NOW },
  );
}

/**
 * What a guard does with the answer: an identity Canopy does not know is a
 * deny, which is how `@canopy-io/nestjs` treats `identity.not_found`. The
 * vector names that case `identity_unknown`.
 */
async function decide(
  authorizer: LocalAuthorizer,
  check: Vector["checks"][number],
): Promise<{ allowed: boolean; reason: string | null }> {
  try {
    return await authorizer.evaluate({
      identity_id: check.identity,
      permission: check.permission,
      scope: check.scope,
      ...(check.node ? { node_id: check.node } : {}),
    });
  } catch (error) {
    if (error instanceof CanopyError && error.code === "identity.not_found") {
      return { allowed: false, reason: "identity_unknown" };
    }

    throw error;
  }
}

const sorted = (values: string[] | null) =>
  values === null ? null : [...values].sort();

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
      )("decides %s", async (_label, check) => {
        expect(await decide(authorizerFor(vector), check)).toEqual({
          allowed: check.allowed,
          reason: check.sdk_reason,
        });
      });

      it.each(
        (vector.machine_client_checks ?? []).map((check) => [
          `${check.machine_client} ${check.permission} ${check.scope}${check.node ? ` at ${check.node}` : ""}`,
          check,
        ]),
      )("decides machine client %s", async (_label, check) => {
        expect(
          await authorizerFor(vector).evaluate({
            identity_id: check.machine_client,
            principal_type: "service",
            permission: check.permission,
            scope: check.scope,
            ...(check.node ? { node_id: check.node } : {}),
          }),
        ).toEqual({
          allowed: check.allowed,
          reason: check.sdk_reason,
        });
      });

      it.each(
        vector.accessible.map((entry) => [
          `${entry.identity} ${entry.permission}`,
          entry,
        ]),
      )("answers where %s may act", async (_label, entry) => {
        const authorizer = authorizerFor(vector);
        const roots = await authorizer.grantRoots(
          entry.identity,
          entry.permission,
        );
        const set = await authorizer.accessibleNodes(
          entry.identity,
          entry.permission,
        );

        expect({
          roots: sorted(roots.roots),
          envWide: roots.envWide,
          nodes: set.nodes === null ? null : sorted([...set.nodes]),
          complete: set.complete,
        }).toEqual({
          roots: sorted(entry.roots),
          envWide: entry.env_wide,
          nodes: sorted(entry.nodes),
          complete: true,
        });
      });

      it.each(
        vector.permissions_at.map((entry) => [
          `${entry.identity} at ${entry.node}`,
          entry,
        ]),
      )("lists what %s holds", async (_label, entry) => {
        expect(
          await authorizerFor(vector).permissionsAt(entry.identity, entry.node),
        ).toEqual(sorted(entry.permissions));
      });

      it.each(
        (vector.holds_anywhere_under ?? []).map((entry) => [
          `${entry.identity} ${entry.permission} under ${entry.subtree_root}`,
          entry,
        ]),
      )("answers whether %s", async (_label, entry) => {
        const answer = await authorizerFor(vector).holdsAnywhereUnder(
          entry.identity,
          entry.permission,
          entry.subtree_root,
        );

        expect({ held: answer.held, roots: sorted(answer.roots) }).toEqual({
          held: entry.held,
          roots: sorted(entry.roots),
        });
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
