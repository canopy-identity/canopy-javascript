import type {
  CanopyClient,
  ConditionalResult,
  RequestOptions,
} from "./client.js";
import { CanopyAuthorizerError } from "./errors.js";
import { paginate, type PageParams } from "./pagination.js";
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
 * The longest a held answer may be kept: five minutes. `ttlMs` is the delay
 * between an access change and it taking effect, and Canopy promises that
 * delay is short, so a longer value is refused rather than honoured.
 */
export const MAX_TTL_MS = 300_000;

/**
 * A tree deep enough to hit this is malformed. The server bounds depth with
 * the hierarchy schema, but a client walking a structure it was handed should
 * not loop forever if that assumption ever fails.
 */
const MAX_WALK_DEPTH = 256;

/**
 * The page size every read here asks for: the largest the API serves, so a
 * walk makes the fewest calls it can.
 */
const PAGE_SIZE = 100;

/**
 * Pages a single read may take before it stops: a million rows at
 * {@link PAGE_SIZE}. Far past any real hierarchy; it exists so a server that
 * keeps promising another page cannot hold a read open forever.
 */
const MAX_PAGES = 10_000;

/**
 * Walks of the hierarchy a refresh may make while the hierarchy keeps
 * changing under it. A walk over several pages is confirmed afterwards (see
 * `fetchTree`); a walk that cannot be confirmed this many times running is
 * kept anyway, without a validator, so the next refresh reads it in full.
 */
const MAX_TREE_WALKS = 3;

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
   *
   * **At most {@link MAX_TTL_MS} (five minutes).** A longer value, a negative
   * one or a non-number throws when the authorizer is created, rather than
   * quietly stretching how long a revoked user keeps access.
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
  /** Reads of an identity's grant roots, one per refresh however many pages it took. */
  grantFetches: number;
  /** Page requests those reads made: at least one per read, one more per further 100 grants. */
  grantPages: number;
  /** Reads of the hierarchy, one per refresh, including revalidations. */
  treeRequests: number;
  /**
   * Page requests those reads made: one for a revalidation the server answers
   * `304`, otherwise one per page of 100 nodes, plus the request that confirms
   * a walk of several pages was not torn by a change made during it.
   */
  treePages: number;
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
 * One page of grant roots, read off the generated operation rather than
 * restated here: one row per permission and node it was granted at.
 *
 * Load-bearing beyond tidiness: typing this through the spec is what stops the
 * package building against a Canopy that does not serve the endpoint. A
 * hand-written shape compiles happily and then 404s on every guarded request
 * at runtime, which the guard turns into a blanket `403` — a failure no test
 * with a faked endpoint can see.
 */
type GrantPage = ResponseBody<"ApiIdentitiesController_getIdentityGrants">;
type GrantRow = GrantPage["items"][number];

/**
 * One page of the hierarchy as parent edges, read off the generated
 * operation, ordered by node id.
 *
 * Deliberately not the node list. `GET /api/v1/nodes` answers what a
 * dashboard renders — names, statuses, access flags, per-node counts — and a
 * walk upward reads none of it. Measured at 50,000 nodes that is 18.6 MB
 * against 5.0 MB, on a read every consuming process makes at startup.
 */
type ParentPage = ResponseBody<"ApiNodesController_listNodeParents">;
type ParentEdge = ParentPage["items"][number];

const GRANTS_PATH = (identityId: string): string =>
  `/api/v1/identities/${encodeURIComponent(identityId)}/grants`;

const PARENTS_PATH = "/api/v1/nodes/parents";

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
    grantPages: 0,
    treeRequests: 0,
    treePages: 0,
    treeNotModified: 0,
  };

  constructor(client: CanopyClient, options: LocalAuthorizerOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs < 0 ||
      this.ttlMs > MAX_TTL_MS
    ) {
      throw new RangeError(
        `ttlMs must be between 0 and ${MAX_TTL_MS} (five minutes); got ${String(this.ttlMs)}. ` +
          "It is how long a revoked user keeps access, so it is capped.",
      );
    }
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
   * permissions edited, a role deactivated or reactivated, a node moved). A
   * deactivated role grants nothing to anyone holding it, so until the cache
   * is cleared or expires, its holders keep being allowed locally.
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
    // about. `GET /api/v1/nodes/parents` answers the hierarchy scoped to the
    // caller, and a credential that cannot read it gets an empty one — with a
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

  /**
   * Every page of the identity's grant roots, folded into permission → nodes.
   *
   * Each row is one permission at one node, so a permission granted at three
   * nodes arrives as three rows, possibly on different pages. Stopping after
   * the first page would under-report what the identity holds: a false deny,
   * the safe direction, but a wrong answer all the same.
   */
  private async fetchGrantRoots(
    identityId: string,
  ): Promise<Map<string, Set<string>>> {
    this.stats.grantFetches += 1;

    const path = GRANTS_PATH(identityId);
    const rows = paginate<GrantRow>(
      (query) => {
        this.stats.grantPages += 1;

        return this.client.request<GrantPage>("GET", path, {
          ...this.readOptions,
          query,
        });
      },
      { page: 1, take: PAGE_SIZE },
      { maxPages: MAX_PAGES },
    );

    const roots = new Map<string, Set<string>>();

    for await (const row of rows) {
      const nodes = roots.get(row.permission);

      if (nodes) {
        nodes.add(row.node_id);
      } else {
        roots.set(row.permission, new Set([row.node_id]));
      }
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
   *
   * The edges come a page at a time, so only the first page is conditional:
   * its validator covers the whole hierarchy, and a `304` to it means no page
   * has changed. On a `200` the remaining pages are read plainly and the map
   * is rebuilt from every page.
   *
   * A walk over several pages is not one snapshot. A node added or removed
   * between two page reads shifts the rows under the offset, so a row can be
   * skipped, which would leave a node out of the map until the next refresh.
   * So the walk is confirmed by asking for the first page again with the
   * validator it came with: a `304` proves nothing changed while the pages
   * were read. A `200` is a fresh first page, and the walk starts again from
   * it, up to {@link MAX_TREE_WALKS} times.
   */
  private async fetchTree(): Promise<Map<string, string | null>> {
    this.stats.treeRequests += 1;

    const held = this.tree;

    let first = await this.parentsFirstPage(held?.etag ?? undefined);

    if (!first.modified) {
      if (held) {
        this.stats.treeNotModified += 1;
        this.tree = { ...held, expiresAt: this.now() + this.ttlMs };

        return held.parents;
      }

      // A `304` to a request that carried no validator has nothing to keep.
      return this.keepTree([], null);
    }

    for (let walk = 1; ; walk++) {
      const edges = await this.parentsRemainingPages(first.data);

      // One page is one response, so it cannot have been torn; without a
      // validator there is nothing to confirm with.
      if (!spansPages(first.data) || first.etag === null) {
        return this.keepTree(edges, first.etag);
      }

      const confirm = await this.parentsFirstPage(first.etag);

      if (!confirm.modified) {
        return this.keepTree(edges, first.etag);
      }

      if (walk >= MAX_TREE_WALKS) {
        // Still changing. Keep the latest walk, but with no validator, so the
        // next refresh reads every page again rather than revalidating a map
        // that may be missing a node.
        return this.keepTree(edges, null);
      }

      first = confirm;
    }
  }

  private parentsFirstPage(
    etag: string | undefined,
  ): Promise<ConditionalResult<ParentPage>> {
    this.stats.treePages += 1;

    return this.client.requestConditional<ParentPage>(
      "GET",
      PARENTS_PATH,
      etag,
      { ...this.readOptions, query: { page: 1, take: PAGE_SIZE } },
    );
  }

  /** The first page's edges followed by every later page's. */
  private async parentsRemainingPages(
    first: ParentPage,
  ): Promise<ParentEdge[]> {
    const edges: ParentEdge[] = [...first.items];

    if (!spansPages(first)) {
      return edges;
    }

    const rest = paginate<ParentEdge>(
      (query: PageParams) => {
        this.stats.treePages += 1;

        return this.client.request<ParentPage>("GET", PARENTS_PATH, {
          ...this.readOptions,
          query,
        });
      },
      { page: first.pagination.page + 1, take: PAGE_SIZE },
      { maxPages: MAX_PAGES - 1 },
    );

    for await (const page of rest.pages()) {
      for (const edge of page.items) {
        edges.push(edge);
      }
    }

    return edges;
  }

  private keepTree(
    edges: ParentEdge[],
    etag: string | null,
  ): Map<string, string | null> {
    // One string per node. A parsed response holds each id twice, once as
    // its own node's `id` and again, as a separate copy, in every child's
    // `parent_node_id`; storing those copies doubled the cache. So the
    // parent is stored as the node's own `id` string, found through a map
    // of every page's ids first, since a parent may arrive after its
    // children, on a later page. The lookup map is gone once this returns.
    const ids = new Map<string, string>();

    for (const edge of edges) {
      ids.set(edge.id, edge.id);
    }

    const parents = new Map<string, string | null>();

    for (const edge of edges) {
      const parent = edge.parent_node_id ?? null;

      parents.set(
        edge.id,
        parent === null ? null : (ids.get(parent) ?? parent),
      );
    }

    this.tree = {
      parents,
      etag,
      expiresAt: this.now() + this.ttlMs,
    };

    return parents;
  }
}

/**
 * Whether a first page says more follow. An empty page ends the walk however
 * the server describes it, as the paginator's own loop does.
 */
function spansPages(first: ParentPage): boolean {
  return first.pagination.has_next_page && first.items.length > 0;
}
