import type { CanopyClient, RequestOptions } from "./client.js";
import { CanopyAuthorizerError } from "./errors.js";
import type { ResponseBody } from "./schema.js";

/**
 * Answers permission checks in-process instead of asking Canopy each time.
 *
 * The inversion this rests on: rather than asking "may this identity act
 * *here*" per request, ask "*where* may it act" once. Canopy answers with the
 * nodes each permission was granted at — the grant roots, deliberately not
 * expanded through their descendants, because a grant already means "this node
 * and everything beneath it". Expanding would restate the hierarchy once per
 * identity, and would be largest for the near-root grants administrators hold.
 *
 * So two things are cached, split by what they depend on:
 *
 *   - grant roots, per identity — small, a handful of assignments
 *   - the hierarchy, once per process — shared, since its shape does not
 *     depend on who is asking
 *
 * and a check becomes a walk up from the node in question looking for a grant
 * root. Both are held for at most `ttlMs`, which is therefore the delay
 * between an access change and it taking effect.
 */

const DEFAULT_TTL_MS = 60_000;

/**
 * A tree deep enough to hit this is malformed. The server bounds depth with
 * the hierarchy schema, but a client walking a structure it was handed should
 * not loop forever if that assumption ever fails.
 */
const MAX_WALK_DEPTH = 256;

export interface LocalAuthorizerOptions {
  /**
   * How long grant roots and the hierarchy are reused, in milliseconds.
   * Defaults to 60s.
   *
   * This is a staleness budget, not a performance dial. Shortening it makes
   * revocation take effect sooner and costs more calls — and below the gap
   * between a user's requests it stops saving anything at all, because every
   * request finds the cache expired and refetches. Human-paced traffic has
   * multi-second gaps, so a value of a few seconds can cost full price for no
   * benefit.
   *
   * **`0` disables caching**, reading fresh on every check. That is the escape
   * for a caller who cannot accept a stale allow at all — it costs a round trip
   * per request, which is what this class exists to avoid, so reach for it
   * knowingly rather than as a default.
   */
  ttlMs?: number;

  /**
   * Per-attempt deadline for the reads this class makes.
   *
   * A cache hit costs nothing, but a miss happens on the request path and
   * holds an inbound request open exactly as a per-request check used to — so
   * the bound still matters, it just applies far less often.
   */
  timeoutMs?: number;

  /** Retries for those reads. */
  maxRetries?: number;

  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface LocalAuthorizationQuery {
  identity_id: string;
  permission: string;
  /** Defaults to `node`, which is the strict question. */
  scope?: "node" | "app_wide";
  node_id?: string;
}

export interface LocalAuthorizerStats {
  /** Calls made to read an identity's grant roots. */
  grantFetches: number;
  /** Calls made to read the hierarchy, including revalidations. */
  treeRequests: number;
  /** Revalidations the server answered `304`, so no tree was transferred. */
  treeNotModified: number;
}

interface GrantEntry {
  roots: Map<string, Set<string>>;
  expiresAt: number;
}

interface TreeEntry {
  parents: Map<string, string | null>;
  etag: string | null;
  expiresAt: number;
}

/**
 * The grant map, read off the generated operation rather than restated here.
 *
 * Load-bearing beyond tidiness: typing this through the spec is what stops the
 * package building against a Canopy that does not serve the endpoint. A
 * hand-written shape compiles happily and then 404s on every guarded request
 * at runtime, which the guard turns into a blanket `403` — a failure no test
 * with a faked endpoint can see.
 */
type GrantMap = ResponseBody<"ApiIdentitiesController_getIdentityGrants">;

/**
 * The hierarchy as parent edges, read off the generated operation.
 *
 * Deliberately not the tree. `GET /api/v1/nodes` answers what a dashboard
 * renders — names, statuses, access flags, per-node counts — and a walk upward
 * reads none of it. Measured at 50,000 nodes that is 18.6 MB against 5.0 MB,
 * on a read every consuming process makes at startup.
 */
type ParentEdges = ResponseBody<"ApiNodesController_listNodeParents">;

export class LocalAuthorizer {
  private readonly client: CanopyClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly readOptions: RequestOptions;

  private readonly grants = new Map<string, GrantEntry>();
  private tree: TreeEntry | undefined;

  /**
   * In-flight reads, so concurrent requests for the same thing share one call.
   *
   * Without this a cold start under load fans out: a hundred simultaneous
   * requests for one identity would each miss the cache and each fetch, which
   * is the per-request traffic this class exists to remove, concentrated into
   * the worst possible moment.
   */
  private readonly pendingGrants = new Map<
    string,
    Promise<Map<string, Set<string>>>
  >();
  private pendingTree: Promise<Map<string, string | null>> | undefined;

  private stats: LocalAuthorizerStats = {
    grantFetches: 0,
    treeRequests: 0,
    treeNotModified: 0,
  };

  constructor(client: CanopyClient, options: LocalAuthorizerOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());

    this.readOptions = {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries, maxBackoffMs: options.timeoutMs }),
    };
  }

  /**
   * Whether the identity holds the permission.
   *
   * Shaped like the API's own evaluate so a caller can swap one for the other.
   * A `node` check with no node is a denial rather than an error: a request
   * whose subject cannot be established is exactly the one that must not pass.
   */
  async evaluate(
    query: LocalAuthorizationQuery,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ allowed: boolean }> {
    if (!options.signal) {
      return this.decide(query);
    }

    // Raced rather than passed down. A read in flight may be shared with other
    // requests — that sharing is the point of the dedup — so cancelling it
    // because *this* caller hung up would abort a fetch the others are still
    // waiting on. Racing ends this call and leaves theirs alone; the fetch runs
    // to completion and warms the cache either way.
    const signal = options.signal;

    let onAbort: (() => void) | undefined;

    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = (): void => {
        // `reason` is whatever the caller passed to `abort()`, which need not
        // be an Error. Keep it when it is, so the original cause survives.
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "aborted")),
        );
      };

      if (signal.aborted) {
        fail();

        return;
      }

      onAbort = fail;
      signal.addEventListener("abort", fail, { once: true });
    });

    // Removed however the race ends, not only when it aborts. `once: true`
    // detaches a listener after it *fires*, which is the case that does not
    // need cleaning up; the common one — the decision winning — would otherwise
    // leave a listener attached for the life of the signal. Harmless for a
    // per-request controller, a leak for any longer-lived one a caller passes.
    return Promise.race([this.decide(query), aborted]).finally(() => {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    });
  }

  private async decide(
    query: LocalAuthorizationQuery,
  ): Promise<{ allowed: boolean }> {
    const roots = await this.grantRootsFor(query.identity_id);
    const granted = roots.get(query.permission);

    if (!granted || granted.size === 0) {
      return { allowed: false };
    }

    if ((query.scope ?? "node") === "app_wide") {
      return { allowed: true };
    }

    if (!query.node_id) {
      return { allowed: false };
    }

    return { allowed: await this.holdsAtNode(granted, query.node_id) };
  }

  /** Counters for observability — how much traffic the cache is actually saving. */
  snapshot(): LocalAuthorizerStats {
    return { ...this.stats };
  }

  /**
   * Drop what is held so the next evaluate refetches.
   *
   * With an `identityId`, only that identity's grants are dropped — the
   * cached hierarchy and every other identity's entries stay warm. This is
   * the shape an assignment webhook wants: the event names the identity
   * whose authority moved, and nothing else needs to pay a refetch for it.
   *
   * With no argument, everything goes: grants and the hierarchy tree. Not
   * needed in normal operation, where entries expire on their own; useful in
   * tests and after a change whose reach you cannot name (a role's
   * permissions edited, a node moved).
   *
   * Multi-instance honesty: an invalidation reaches THIS process only. A
   * webhook lands on one instance behind a load balancer; the others serve
   * their cached grants until their own TTL expires. Unless the app fans the
   * event out over its own pub/sub, the fleet-wide revocation guarantee is
   * the TTL, and webhook-driven invalidation is a latency optimization on
   * top of it — size the TTL to the revocation latency you can promise.
   */
  invalidate(identityId?: string): void {
    if (identityId !== undefined) {
      this.grants.delete(identityId);

      return;
    }

    this.grants.clear();
    this.tree = undefined;
  }

  /** Climb from `nodeId` and look for a grant root among its ancestors. */
  private async holdsAtNode(
    granted: Set<string>,
    nodeId: string,
  ): Promise<boolean> {
    // Checked before walking, so a grant at the node itself needs no tree at
    // all — which also means an unreachable hierarchy cannot deny a direct
    // grant that was already resolved.
    if (granted.has(nodeId)) {
      return true;
    }

    const parents = await this.parents();

    // The hierarchy we hold has to actually contain the node being asked
    // about. `GET /api/v1/nodes` answers a tree scoped to the caller, and a
    // credential that cannot read the hierarchy gets an empty one — with a
    // `200`, so nothing looks wrong. Walking off the end of that map would
    // return `false`, which reads as "this identity lacks the permission
    // here" when the truth is that we cannot see far enough to say.
    //
    // Denying would be a silent, total false-deny on every node-scoped route.
    // Undecidable is not denied, so this is raised rather than answered.
    if (!parents.has(nodeId)) {
      throw new CanopyAuthorizerError(
        "authorizer.hierarchy_incomplete",
        `The hierarchy this client can read does not contain node "${nodeId}", so authorization at that node cannot be decided. ` +
          "A scoped API key needs the `hierarchy.view` scope to read the tree.",
      );
    }

    let current = parents.get(nodeId);
    let depth = 0;

    while (current && depth < MAX_WALK_DEPTH) {
      if (granted.has(current)) {
        return true;
      }

      current = parents.get(current);
      depth += 1;
    }

    return false;
  }

  private async grantRootsFor(
    identityId: string,
  ): Promise<Map<string, Set<string>>> {
    const cached = this.grants.get(identityId);

    if (cached && cached.expiresAt > this.now()) {
      return cached.roots;
    }

    const pending = this.pendingGrants.get(identityId);

    if (pending) {
      return pending;
    }

    const read = this.fetchGrantRoots(identityId).finally(() => {
      this.pendingGrants.delete(identityId);
    });

    this.pendingGrants.set(identityId, read);

    return read;
  }

  private async fetchGrantRoots(
    identityId: string,
  ): Promise<Map<string, Set<string>>> {
    this.stats.grantFetches += 1;

    const response = await this.client.request<GrantMap>(
      "GET",
      `/api/v1/identities/${encodeURIComponent(identityId)}/grants`,
      this.readOptions,
    );

    const roots = new Map<string, Set<string>>();

    for (const row of response.items ?? []) {
      roots.set(row.permission, new Set(row.nodes));
    }

    this.grants.set(identityId, {
      roots,
      expiresAt: this.now() + this.ttlMs,
    });

    return roots;
  }

  private async parents(): Promise<Map<string, string | null>> {
    if (this.tree && this.tree.expiresAt > this.now()) {
      return this.tree.parents;
    }

    if (this.pendingTree) {
      return this.pendingTree;
    }

    const read = this.fetchTree().finally(() => {
      this.pendingTree = undefined;
    });

    this.pendingTree = read;

    return read;
  }

  /**
   * Revalidate rather than re-read. The hierarchy is the expensive half and
   * the one that changes least, so the common case is a `304` and no transfer
   * at all — the tree stays in memory and only its expiry moves.
   */
  private async fetchTree(): Promise<Map<string, string | null>> {
    this.stats.treeRequests += 1;

    const held = this.tree;

    const result = await this.client.requestConditional<ParentEdges>(
      "GET",
      "/api/v1/nodes/parents",
      held?.etag ?? undefined,
      this.readOptions,
    );

    if (!result.modified && held) {
      this.stats.treeNotModified += 1;
      this.tree = { ...held, expiresAt: this.now() + this.ttlMs };

      return held.parents;
    }

    const parents = new Map<string, string | null>();

    if (result.modified) {
      for (const edge of result.data.items) {
        parents.set(edge.id, edge.parent_node_id ?? null);
      }
    }

    this.tree = {
      parents,
      etag: result.modified ? result.etag : (held?.etag ?? null),
      expiresAt: this.now() + this.ttlMs,
    };

    return parents;
  }
}
