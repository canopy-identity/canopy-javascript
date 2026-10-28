import type {
  CanopyClient,
  ConditionalResult,
  RequestOptions,
} from "./client.js";
import { CanopyAuthorizerError } from "./errors.js";
import {
  type AppliedChange,
  type AuthorizationChange,
  invalidationFor,
} from "./invalidation.js";
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
 *   - grant roots, per identity — small, a handful of assignments, each with
 *     the window it is in effect for — and the deny roots read with them, the
 *     nodes a deny refuses the identity a permission at
 *   - the hierarchy, once per process — shared, since its shape does not
 *     depend on who is asking
 *
 * and a check becomes a walk up from the node in question: refused when a
 * deny root for the permission is on the way, otherwise allowed when a grant
 * root in effect is. Both are held for at most `ttlMs`, which is therefore the
 * delay between an access change and it taking effect; a grant whose window
 * opens or closes sooner than that is re-read at the boundary.
 */

const DEFAULT_TTL_MS = 60_000;

/**
 * The longest a held answer may be kept: five minutes. `ttlMs` is the delay
 * between an access change and it taking effect, and Canopy promises that
 * delay is short, so a longer value is refused rather than honoured.
 */
export const MAX_TTL_MS = 300_000;

/**
 * The largest node set `accessibleNodes` builds unless told otherwise. Past
 * it the answer carries the roots alone, and the caller filters against its
 * own closure table or materialised path instead of an `IN (...)` list.
 */
export const DEFAULT_MAX_NODES = 10_000;

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

/** The change feed `replayChanges` reads. */
const CHANGES_PATH = "/api/v1/changes";

/** The change feed's largest page. */
const CHANGES_PAGE_SIZE = 200;

/**
 * Why a check was denied, as far as the grant roots and the tree can say.
 *
 * - `permission_not_held`: no assignment grants the permission anywhere, in
 *   effect or not.
 * - `outside_grants`: it is granted, but at no node on the lineage of the
 *   node asked about.
 * - `expired`: a grant that would answer has ended, and none is in effect.
 * - `not_yet_effective`: a grant that would answer has not begun, and none
 *   is in effect.
 * - `node_missing`: a `node` check named no node, which is a denial rather
 *   than an error, because a request whose subject cannot be established
 *   must not pass.
 * - `denied`: a deny refuses the permission, at the node or above it, or,
 *   for `app_wide`, over every grant in effect. No grant beneath a deny
 *   undoes it.
 */
export type LocalDenialReason =
  | "permission_not_held"
  | "outside_grants"
  | "expired"
  | "not_yet_effective"
  | "node_missing"
  | "denied";

/** The answer to a check: the verdict, and why when it is no. */
export interface LocalDecision {
  allowed: boolean;
  reason: LocalDenialReason | null;
}

/** What a decision hook receives, after the verdict is in. */
export interface LocalDecisionEvent {
  query: LocalAuthorizationQuery;
  decision: LocalDecision;
  /** How long the check took, reads included. */
  durationMs: number;
}

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

  /**
   * The largest node set {@link LocalAuthorizer.accessibleNodes} builds
   * unless a call says otherwise. Defaults to {@link DEFAULT_MAX_NODES}.
   */
  maxNodes?: number;

  /**
   * Called after every decision, allowed or not, with the question and the
   * answer. Never awaited and never allowed to fail the check: a hook that
   * throws is ignored. For audit trails and metrics.
   */
  onDecision?: (event: LocalDecisionEvent) => void;

  /** Called after every denial, the same way. For alerting on refusals. */
  onDenied?: (event: LocalDecisionEvent) => void;

  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Which kind of principal a subject id names. An identity is a person; a
 * `service` is a machine OAuth client acting for itself, whose id is its
 * `client_id` (the `sub` of its token). Both ids are UUIDs, so the kind is
 * stated rather than guessed: it decides where the grants are read from.
 */
export type PrincipalType = "identity" | "service";

/** Names the subject's kind on the calls that take a bare id. */
export interface SubjectOptions {
  /** Defaults to `identity`. */
  principalType?: PrincipalType;
}

export interface LocalAuthorizationQuery {
  /** The subject: an identity's id, or a machine client's `client_id`. */
  identity_id: string;
  /**
   * What `identity_id` names. Defaults to `identity`; set `service` for a
   * machine client, whose grants are read from its own endpoint. Read it off
   * the verified token's `type` claim, never off the request.
   */
  principal_type?: PrincipalType;
  permission: string;
  /** Defaults to `node`, which is the strict question. */
  scope?: "node" | "app_wide";
  node_id?: string;
}

/** Where an identity may act with one permission, shaped for a list query. */
export interface AccessibleNodes {
  /**
   * The nodes the permission is granted at, in effect now, that no other
   * such node already covers and no deny refuses. Each reaches everything
   * beneath it, except the `excludedRoots` inside it.
   */
  roots: string[];
  /**
   * The nodes beneath a root where a deny refuses the permission, each cut
   * out with everything beneath it. A filter by roots excludes these too.
   */
  excludedRoots: string[];
  /**
   * Every node beneath the roots, the roots included and the excluded
   * subtrees left out, for an `IN (...)` filter. Null when `envWide`, or
   * when the set would exceed the cap.
   */
  nodes: Set<string> | null;
  /** False when the set exceeded the cap and `nodes` was not built. */
  complete: boolean;
  /**
   * True when a root is the Environment's own root and no deny cuts anything
   * out: every node qualifies, so a list needs no filter at all.
   */
  envWide: boolean;
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

/** One grant root with the window it is in effect for, as epoch milliseconds. */
interface GrantWindow {
  node: string;
  from: number | null;
  to: number | null;
}

/** Permission → every root it was granted at, in effect or not. */
type GrantRoots = Map<string, GrantWindow[]>;

/**
 * Permission → the nodes a deny refuses it at, each reaching everything
 * beneath it. Canopy resolves the denies for the subject before sending them
 * (the roles it holds, the exception roles that spare it), so a root here
 * binds without further reading.
 */
type DenyRoots = Map<string, Set<string>>;

/** What one read of a subject's grants answers. */
interface Holdings {
  roots: GrantRoots;
  denies: DenyRoots;
}

interface GrantEntry {
  holdings: Holdings;
  expiresAt: number;
}

interface TreeEntry {
  parents: Map<string, string | null>;
  /** Node → its children, for expanding a root through its descendants. */
  children: Map<string, string[]>;
  etag: string | null;
  expiresAt: number;
}

/**
 * One page of grant roots, read off the generated operation rather than
 * restated here: one row per permission, node and assignment window.
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
type ChangePage = ResponseBody<"ApiChangesController_query">;

/**
 * The versions of Canopy's authorization model this authorizer understands.
 *
 * The grants and parents responses name the model their rows describe. Canopy
 * raises the version when a change makes a walk up the tree answer
 * differently for the same rows. An authorizer that walked on regardless
 * would allow what the API has started to deny, so a version not listed here
 * is refused, and the fix is upgrading this package.
 *
 * - 1: the walk alone. Allowed when a grant root in effect is at or above the
 *   node.
 * - 2: denies. The grants answer carries the subject's deny roots, and a deny
 *   root at or above the node refuses before any grant is read. Canopy
 *   answers 2 only in an Environment that holds a deny.
 */
const KNOWN_MODEL_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** A page as served, once its model version is known to be understood. */
function understood<T extends { model_version: number }>(
  page: T,
  path: string,
): T {
  if (!KNOWN_MODEL_VERSIONS.has(page.model_version)) {
    throw new CanopyAuthorizerError(
      "authorizer.model_version_unknown",
      `${path} describes authorization model version ${page.model_version}, which this version of @canopy-io/node does not understand. ` +
        `It knows ${[...KNOWN_MODEL_VERSIONS].join(", ")}. Upgrade @canopy-io/node; until then this authorizer cannot decide, rather than guess.`,
    );
  }

  return page;
}

/** Where a subject's grant roots are read: one endpoint per principal kind, the same page shape. */
const GRANTS_PATH = (type: PrincipalType, id: string): string =>
  type === "service"
    ? `/api/v1/oauth-clients/${encodeURIComponent(id)}/grants`
    : `/api/v1/identities/${encodeURIComponent(id)}/grants`;

/** The cache key: the kind and the id, so two kinds sharing an id never collide. */
const subjectKey = (type: PrincipalType, id: string): string => `${type}:${id}`;

const PARENTS_PATH = "/api/v1/nodes/parents";

/** Whether a grant window is in effect at `now`. */
function inEffect(window: GrantWindow, now: number): boolean {
  return (
    (window.from === null || window.from <= now) &&
    (window.to === null || window.to > now)
  );
}

/** The denial a set of windows that could answer, none in effect, explains. */
function reasonAmong(
  windows: GrantWindow[],
  now: number,
): "expired" | "not_yet_effective" {
  return windows.some((window) => window.to !== null && window.to <= now)
    ? "expired"
    : "not_yet_effective";
}

/** Whether a deny root is on a lineage: at the node or above it. */
function refusedOn(
  denied: ReadonlySet<string> | undefined,
  lineage: Iterable<string>,
): boolean {
  if (!denied) {
    return false;
  }

  for (const node of lineage) {
    if (denied.has(node)) {
      return true;
    }
  }

  return false;
}

export interface ReplayChangesOptions {
  /**
   * Where the last replay stopped: the `cursor` it returned. Omit it the
   * first time, and the replay starts at the oldest change Canopy still
   * retains.
   */
  cursor?: string | null;
}

export interface ReplayChangesResult {
  /**
   * Where this replay stopped. Keep it, and pass it to the next replay;
   * `null` only when the feed has never held a change.
   */
  cursor: string | null;
  /** How many changes were read and applied. */
  changes: number;
  /** Whether any change dropped the whole cache. */
  invalidatedAll: boolean;
  /** How many subjects' grants were dropped one at a time. */
  subjectsInvalidated: number;
}

export class LocalAuthorizer {
  private readonly client: CanopyClient;
  private readonly ttlMs: number;
  private readonly maxNodes: number;
  private readonly now: () => number;
  private readonly readOptions: RequestOptions;
  private readonly onDecision:
    ((event: LocalDecisionEvent) => void) | undefined;
  private readonly onDenied: ((event: LocalDecisionEvent) => void) | undefined;

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
  private readonly pendingGrants = new Map<string, Promise<Holdings>>();
  private pendingTree: Promise<TreeEntry> | undefined;

  /**
   * Bumped by every full invalidation. A hierarchy read that began before
   * the bump answers the caller that was waiting on it but is not kept, so
   * a read already in flight when a change lands cannot cache what the
   * change replaced. Grants use the pending map for the same purpose.
   */
  private treeGeneration = 0;

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

    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

    if (!Number.isInteger(this.maxNodes) || this.maxNodes < 1) {
      throw new RangeError(
        `maxNodes must be a positive integer; got ${String(this.maxNodes)}.`,
      );
    }

    this.now = options.now ?? (() => Date.now());
    this.onDecision = options.onDecision;
    this.onDenied = options.onDenied;

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
   * Whether the identity holds the permission, and why not when it does not.
   *
   * Shaped like the API's own evaluate so a caller can swap one for the other.
   * A `node` check with no node is a denial rather than an error: a request
   * whose subject cannot be established is exactly the one that must not pass.
   */
  async evaluate(
    query: LocalAuthorizationQuery,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalDecision> {
    const started = this.now();
    const decided = (decision: LocalDecision): LocalDecision => {
      this.announce({
        query,
        decision,
        durationMs: Math.max(0, this.now() - started),
      });

      return decision;
    };

    if (!options.signal) {
      return decided(await this.decide(query));
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
    return Promise.race([this.decide(query), aborted])
      .then(decided)
      .finally(() => {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      });
  }

  /**
   * The nodes the identity holds the permission at, in effect now, reduced to
   * the ones no other such node already covers, and whether one of them is
   * the Environment's root. The roots alone are enough for an application
   * that keeps a closure table or a materialised path: it filters by "beneath
   * one of these" without an expanded set.
   *
   * A grant a deny refuses (a deny root at its node or above it) is left out,
   * and a deny root beneath a root is named in `excludedRoots`, so the filter
   * becomes "beneath one of the roots and not beneath an excluded one".
   * `envWide` holds only while nothing is excluded.
   *
   * Reads the tree, since minimality and `envWide` are questions about it; a
   * root the readable hierarchy does not contain raises
   * `authorizer.hierarchy_incomplete`, as a check at such a node does.
   */
  async grantRoots(
    identityId: string,
    permission: string,
    subject: SubjectOptions = {},
  ): Promise<{ roots: string[]; excludedRoots: string[]; envWide: boolean }> {
    const now = this.now();
    const holdings = await this.grantRootsFor(
      identityId,
      subject.principalType ?? "identity",
    );
    const granted = new Set(
      (holdings.roots.get(permission) ?? [])
        .filter((window) => inEffect(window, now))
        .map((w) => w.node),
    );

    if (granted.size === 0) {
      return { roots: [], excludedRoots: [], envWide: false };
    }

    const denied = holdings.denies.get(permission);
    const { parents } = await this.treeEntry();
    const roots: string[] = [];
    let rootGranted = false;

    for (const node of granted) {
      if (!parents.has(node)) {
        throw this.hierarchyIncomplete(node);
      }

      const path = this.lineage(parents, node);

      if (refusedOn(denied, path)) {
        continue;
      }

      if (parents.get(node) === null) {
        rootGranted = true;
      }

      if (!path.slice(1).some((n) => granted.has(n))) {
        roots.push(node);
      }
    }

    const excludedRoots = this.excludedBeneath(parents, denied, roots);

    return {
      roots,
      excludedRoots,
      envWide: rootGranted && excludedRoots.length === 0,
    };
  }

  /**
   * Where the identity may act with the permission, as the set a list query
   * filters by: {@link grantRoots} expanded through their descendants, the
   * subtrees beneath `excludedRoots` left out, up to `maxNodes` (the
   * authorizer's default unless given here).
   *
   * Past the cap `nodes` is null and `complete` false: the set is too large
   * to be worth an `IN (...)` list, and the caller filters by `roots` and
   * `excludedRoots` instead. An `envWide` answer carries no set either, since
   * every node qualifies and a filter would only slow the query down.
   *
   * Computed from the same cached grant roots and tree a check uses, so a
   * list filtered by it and the check on a write cannot disagree, and it goes
   * stale on the same `ttlMs`.
   */
  async accessibleNodes(
    identityId: string,
    permission: string,
    options: { maxNodes?: number } & SubjectOptions = {},
  ): Promise<AccessibleNodes> {
    const cap = options.maxNodes ?? this.maxNodes;
    const { roots, excludedRoots, envWide } = await this.grantRoots(
      identityId,
      permission,
      {
        ...(options.principalType
          ? { principalType: options.principalType }
          : {}),
      },
    );

    if (envWide) {
      return {
        roots,
        excludedRoots,
        envWide: true,
        nodes: null,
        complete: true,
      };
    }

    if (roots.length === 0) {
      return {
        roots,
        excludedRoots,
        envWide: false,
        nodes: new Set(),
        complete: true,
      };
    }

    const { children } = await this.treeEntry();
    const excluded = new Set(excludedRoots);
    const nodes = new Set<string>();
    const pending = [...roots];

    while (pending.length > 0) {
      const node = pending.pop() as string;

      if (nodes.has(node) || excluded.has(node)) {
        continue;
      }

      nodes.add(node);

      if (nodes.size > cap) {
        return {
          roots,
          excludedRoots,
          envWide: false,
          nodes: null,
          complete: false,
        };
      }

      for (const child of children.get(node) ?? []) {
        pending.push(child);
      }
    }

    return { roots, excludedRoots, envWide: false, nodes, complete: true };
  }

  /**
   * Whether the identity holds the permission anywhere at or beneath a node,
   * and where: the question a menu inside an organization asks ("show
   * Invoices to someone who approves invoices for any team in Acme"), which
   * `app_wide` cannot answer because it covers the whole Environment.
   *
   * `roots` is `[subtreeRootId]` when a grant at the node or above it reaches
   * the whole subtree; otherwise the topmost granted nodes inside it, the
   * ones no other granted node inside it already covers. A list query filters
   * by "beneath one of these and not beneath one of `excludedRoots`", the
   * deny roots inside them. A deny at the node or above it refuses the whole
   * subtree, and a grant a deny refuses counts for nothing.
   *
   * **A read for menus and lists, never a guard.** Holding the permission
   * somewhere in the subtree says nothing about the record a write touches:
   * check the node the action writes to, with `evaluate`. No `scope` value
   * asks this question, on purpose.
   *
   * Computed from the same cached grant roots and tree a check uses. A grant
   * or a subtree root the readable hierarchy does not contain raises
   * `authorizer.hierarchy_incomplete`, as a check at such a node does.
   */
  async holdsAnywhereUnder(
    identityId: string,
    permission: string,
    subtreeRootId: string,
    subject: SubjectOptions = {},
  ): Promise<{ held: boolean; roots: string[]; excludedRoots: string[] }> {
    const now = this.now();
    const holdings = await this.grantRootsFor(
      identityId,
      subject.principalType ?? "identity",
    );
    const granted = new Set(
      (holdings.roots.get(permission) ?? [])
        .filter((window) => inEffect(window, now))
        .map((w) => w.node),
    );
    const denied = holdings.denies.get(permission);
    const { parents } = await this.treeEntry();

    if (!parents.has(subtreeRootId)) {
      throw this.hierarchyIncomplete(subtreeRootId);
    }

    const above = this.lineage(parents, subtreeRootId);

    if (granted.size === 0 || refusedOn(denied, above)) {
      return { held: false, roots: [], excludedRoots: [] };
    }

    // The subtree's root is clear of every deny, so a grant on its lineage is too.
    if (above.some((n) => granted.has(n))) {
      return {
        held: true,
        roots: [subtreeRootId],
        excludedRoots: this.excludedBeneath(parents, denied, [subtreeRootId]),
      };
    }

    const roots: string[] = [];

    for (const node of granted) {
      if (!parents.has(node)) {
        throw this.hierarchyIncomplete(node);
      }

      const path = this.lineage(parents, node);

      if (refusedOn(denied, path)) {
        continue;
      }

      const ancestors = path.slice(1);

      if (
        ancestors.includes(subtreeRootId) &&
        !ancestors.some((n) => granted.has(n))
      ) {
        roots.push(node);
      }
    }

    return {
      held: roots.length > 0,
      roots,
      excludedRoots: this.excludedBeneath(parents, denied, roots),
    };
  }

  /** The node and every ancestor up to the root, nearest first. */
  private lineage(
    parents: Map<string, string | null>,
    nodeId: string,
  ): string[] {
    const path: string[] = [];
    let depth = 0;

    for (
      let current: string | null | undefined = nodeId;
      current && depth < MAX_WALK_DEPTH;
      current = parents.get(current), depth += 1
    ) {
      path.push(current);
    }

    return path;
  }

  /**
   * The deny roots strictly beneath one of `roots`: the subtrees a filter by
   * those roots has to cut out. A deny root at a root or above it never
   * reaches here, because that root was refused and left out.
   */
  private excludedBeneath(
    parents: Map<string, string | null>,
    denied: ReadonlySet<string> | undefined,
    roots: readonly string[],
  ): string[] {
    if (!denied || roots.length === 0) {
      return [];
    }

    const rootSet = new Set(roots);
    const excluded: string[] = [];

    for (const node of denied) {
      if (!parents.has(node)) {
        throw this.hierarchyIncomplete(node);
      }

      if (
        this.lineage(parents, node)
          .slice(1)
          .some((n) => rootSet.has(n))
      ) {
        excluded.push(node);
      }
    }

    return excluded;
  }

  /**
   * Every permission the identity holds at the node, by grant or by
   * inheritance, less those a deny refuses there: the list a screen renders
   * its controls from, answered from the same cached grant roots and tree a
   * check uses.
   */
  async permissionsAt(
    identityId: string,
    nodeId: string,
    subject: SubjectOptions = {},
  ): Promise<string[]> {
    const answers = await this.permissionsAtMany(identityId, [nodeId], subject);

    return answers.get(nodeId) ?? [];
  }

  /**
   * {@link permissionsAt} for several nodes at once, as node → permissions:
   * the rows of a list each with their own controls, answered from one read
   * of the grant roots and one walk per node.
   */
  async permissionsAtMany(
    identityId: string,
    nodeIds: readonly string[],
    subject: SubjectOptions = {},
  ): Promise<Map<string, string[]>> {
    const now = this.now();
    const holdings = await this.grantRootsFor(
      identityId,
      subject.principalType ?? "identity",
    );
    const answers = new Map<string, string[]>();

    for (const nodeId of new Set(nodeIds)) {
      const path = await this.lineageOf(nodeId);
      const held: string[] = [];

      for (const [permission, windows] of holdings.roots) {
        if (refusedOn(holdings.denies.get(permission), path)) {
          continue;
        }

        if (
          windows.some(
            (window) => path.has(window.node) && inEffect(window, now),
          )
        ) {
          held.push(permission);
        }
      }

      answers.set(nodeId, held.sort());
    }

    return answers;
  }

  private async decide(query: LocalAuthorizationQuery): Promise<LocalDecision> {
    const now = this.now();
    const holdings = await this.grantRootsFor(
      query.identity_id,
      query.principal_type ?? "identity",
    );
    const held = holdings.roots.get(query.permission) ?? [];
    const denied = holdings.denies.get(query.permission);

    if ((query.scope ?? "node") === "app_wide") {
      if (held.length === 0) {
        return { allowed: false, reason: "permission_not_held" };
      }

      const standing = held.filter((window) => inEffect(window, now));

      if (standing.length === 0) {
        return { allowed: false, reason: reasonAmong(held, now) };
      }

      // Held anywhere while one grant in effect stands clear of every deny.
      return (await this.anyClearOf(denied, standing))
        ? { allowed: true, reason: null }
        : { allowed: false, reason: "denied" };
    }

    if (held.length === 0 && !denied) {
      return { allowed: false, reason: "permission_not_held" };
    }

    if (!query.node_id) {
      return { allowed: false, reason: "node_missing" };
    }

    // A deny at the node or above it refuses before any grant is read, and
    // no grant beneath it undoes it.
    if (denied && refusedOn(denied, await this.lineageOf(query.node_id))) {
      return { allowed: false, reason: "denied" };
    }

    if (held.length === 0) {
      return { allowed: false, reason: "permission_not_held" };
    }

    // A grant in effect at the node itself needs no tree at all, which also
    // means an unreachable hierarchy cannot deny a direct grant.
    if (
      held.some(
        (window) => window.node === query.node_id && inEffect(window, now),
      )
    ) {
      return { allowed: true, reason: null };
    }

    const path = await this.lineageOf(query.node_id);
    const reachable = held.filter((window) => path.has(window.node));

    if (reachable.some((window) => inEffect(window, now))) {
      return { allowed: true, reason: null };
    }

    if (reachable.length === 0) {
      return { allowed: false, reason: "outside_grants" };
    }

    return { allowed: false, reason: reasonAmong(reachable, now) };
  }

  /**
   * Whether one of the grants stands clear of every deny root: none at its
   * node or above it. A grant with a deny strictly beneath it still reaches
   * the rest of its subtree. Reads the tree only when there is a deny.
   */
  private async anyClearOf(
    denied: ReadonlySet<string> | undefined,
    windows: GrantWindow[],
  ): Promise<boolean> {
    if (!denied) {
      return true;
    }

    for (const window of windows) {
      if (!refusedOn(denied, await this.lineageOf(window.node))) {
        return true;
      }
    }

    return false;
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
   * An event naming a machine client (`oauth_client_id`, with `identity_id`
   * null) passes that client's `client_id` with `principalType: "service"`.
   *
   * With no argument, everything goes: grants and the hierarchy tree. Not
   * needed in normal operation, where entries expire on their own; useful in
   * tests and after a change whose reach you cannot name (a role's
   * permissions edited, a role deactivated or reactivated, a node moved, a
   * deny created or deleted, since a deny on a role binds everyone holding
   * it). A
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
  invalidate(identityId?: string, subject: SubjectOptions = {}): void {
    if (identityId !== undefined) {
      const key = subjectKey(subject.principalType ?? "identity", identityId);

      // A read in flight began before the change; it answers whoever is
      // waiting on it, but the next check reads again rather than joining it.
      this.grants.delete(key);
      this.pendingGrants.delete(key);

      return;
    }

    this.grants.clear();
    this.pendingGrants.clear();
    this.tree = undefined;
    this.pendingTree = undefined;
    this.treeGeneration += 1;
  }

  /**
   * Drop what one change makes stale, from a webhook delivery or a
   * change-feed entry (the two share one shape). Answers what it dropped.
   *
   * A change naming whose access moved (an assignment, an Environment or
   * organization membership, an identity's status, a deny on one person,
   * a machine client disabled or deleted) drops those subjects' grants and
   * keeps everyone else's and the hierarchy warm. A change whose reach it
   * cannot name (a role, a permission, a node, the hierarchy schema, an
   * organization created or deleted, a deny on a role or a machine client,
   * a directory group mapped) drops everything. A change that moves no
   * one's access (a profile edit, a sign-in policy, a session revoked)
   * drops nothing. An event this SDK does not know drops everything.
   *
   * Check the delivery's signature first (`verifyWebhookSignature`): this
   * trusts what it is given. Like {@link invalidate}, it reaches this
   * process only; see there for what that means across several instances.
   */
  applyEvent(change: AuthorizationChange): AppliedChange {
    const reach = invalidationFor(change);

    if (reach === "none") {
      return { event: change.event, invalidated: "none" };
    }

    if (reach === "all") {
      this.invalidate();

      return { event: change.event, invalidated: "all" };
    }

    for (const subject of reach) {
      this.invalidate(subject.id, { principalType: subject.principalType });
    }

    return { event: change.event, invalidated: "subjects", subjects: reach };
  }

  /**
   * Read `GET /api/v1/changes` from `cursor` to the newest change and apply
   * each one, as {@link applyEvent} would a webhook. Answers the cursor to
   * resume from next time.
   *
   * Two uses. After a restart, to catch up on deliveries a process missed
   * while it was down, before it serves from a cache warmed elsewhere. And
   * in place of webhooks: every instance polling on an interval shorter
   * than `ttlMs` sees every change, which a webhook (delivered to one
   * instance) does not give a fleet.
   *
   * The feed holds what the audit log retains, so a cursor older than that
   * resumes at the oldest change still held. Each page is one request; a
   * replay with no cursor walks the whole retained window once.
   */
  async replayChanges(
    options: ReplayChangesOptions = {},
  ): Promise<ReplayChangesResult> {
    let cursor = options.cursor ?? null;
    let changes = 0;
    let invalidatedAll = false;
    let subjectsInvalidated = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const read: ChangePage = await this.client.request<ChangePage>(
        "GET",
        CHANGES_PATH,
        {
          ...this.readOptions,
          query: {
            limit: CHANGES_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
          },
        },
      );

      for (const change of read.items) {
        const applied = this.applyEvent(change);

        changes += 1;

        if (applied.invalidated === "all") {
          invalidatedAll = true;
        }

        if (applied.invalidated === "subjects") {
          subjectsInvalidated += applied.subjects.length;
        }
      }

      const next = read.pagination.next_cursor;

      // A short page is the newest change; the feed echoes the cursor it was
      // given once it has nothing newer, so an unchanged cursor ends it too.
      const caughtUp =
        read.items.length < CHANGES_PAGE_SIZE ||
        next === null ||
        next === cursor;

      cursor = next ?? cursor;

      if (caughtUp) {
        break;
      }
    }

    return { cursor, changes, invalidatedAll, subjectsInvalidated };
  }

  /** Fire the decision hooks, after the verdict and without waiting on them. */
  private announce(event: LocalDecisionEvent): void {
    for (const hook of [
      this.onDecision,
      event.decision.allowed ? undefined : this.onDenied,
    ]) {
      if (!hook) {
        continue;
      }

      try {
        hook(event);
      } catch {
        // A hook is observation. Its failure must not become a denial, an
        // allow, or an error the caller sees.
      }
    }
  }

  /** The node and its ancestors, from the tree this client can read. */
  private async lineageOf(nodeId: string): Promise<Set<string>> {
    const { parents } = await this.treeEntry();

    // The hierarchy we hold has to actually contain the node being asked
    // about. `GET /api/v1/nodes/parents` answers the hierarchy scoped to the
    // caller, and a credential that cannot read it gets an empty one — with a
    // `200`, so nothing looks wrong. Walking off the end of that map would
    // answer as if the node had no ancestors, which reads as "this identity
    // lacks the permission here" when the truth is that we cannot see far
    // enough to say.
    //
    // Denying would be a silent, total false-deny on every node-scoped route.
    // Undecidable is not denied, so this is raised rather than answered.
    if (!parents.has(nodeId)) {
      throw this.hierarchyIncomplete(nodeId);
    }

    const path = new Set<string>([nodeId]);
    let current = parents.get(nodeId);
    let depth = 0;

    while (current && depth < MAX_WALK_DEPTH) {
      path.add(current);
      current = parents.get(current);
      depth += 1;
    }

    return path;
  }

  private hierarchyIncomplete(nodeId: string): CanopyAuthorizerError {
    return new CanopyAuthorizerError(
      "authorizer.hierarchy_incomplete",
      `The hierarchy this client can read does not contain node "${nodeId}", so authorization at that node cannot be decided. ` +
        "A scoped API key needs the `hierarchy.view` scope to read the tree.",
    );
  }

  private async grantRootsFor(
    identityId: string,
    type: PrincipalType,
  ): Promise<Holdings> {
    const key = subjectKey(type, identityId);
    const cached = this.grants.get(key);

    if (cached && cached.expiresAt > this.now()) {
      return cached.holdings;
    }

    const pending = this.pendingGrants.get(key);

    if (pending) {
      return pending;
    }

    const read: Promise<Holdings> = this.fetchGrantRoots(
      identityId,
      type,
      () => this.pendingGrants.get(key) === read,
    ).finally(() => {
      if (this.pendingGrants.get(key) === read) {
        this.pendingGrants.delete(key);
      }
    });

    this.pendingGrants.set(key, read);

    return read;
  }

  /**
   * Every page of the identity's grant roots, with their windows, folded
   * into permission → roots.
   *
   * Each row is one permission at one node for one assignment, so a
   * permission granted at three nodes arrives as three rows, possibly on
   * different pages. Stopping after the first page would under-report what
   * the identity holds: a false deny, the safe direction, but a wrong answer
   * all the same.
   *
   * Rows outside their window are kept: they are what lets a denial say
   * `expired` or `not_yet_effective`, and the entry expires at the nearest
   * window boundary when that comes before the TTL, so a grant takes effect
   * or ends on time rather than up to `ttlMs` late.
   *
   * Every page carries the subject's deny roots whole, beside its rows; they
   * are gathered from each page, so a read is one snapshot of both.
   */
  private async fetchGrantRoots(
    identityId: string,
    type: PrincipalType,
    stillCurrent: () => boolean = () => true,
  ): Promise<Holdings> {
    this.stats.grantFetches += 1;

    const path = GRANTS_PATH(type, identityId);
    const denies: DenyRoots = new Map();
    const rows = paginate<GrantRow>(
      (query) => {
        this.stats.grantPages += 1;

        return this.client
          .request<GrantPage>("GET", path, {
            ...this.readOptions,
            query: { ...query, include: "windows" },
          })
          .then((page) => {
            // A version 1 answer comes from a Canopy that predates denies,
            // which sends no `denies` at all.
            const read: GrantPage["denies"] | undefined = understood(
              page,
              path,
            ).denies;

            for (const deny of read ?? []) {
              const nodes = denies.get(deny.permission);

              if (nodes) {
                nodes.add(deny.node_id);
              } else {
                denies.set(deny.permission, new Set([deny.node_id]));
              }
            }

            return page;
          });
      },
      { page: 1, take: PAGE_SIZE },
      { maxPages: MAX_PAGES },
    );

    const roots: GrantRoots = new Map();
    const now = this.now();
    let boundary = Number.POSITIVE_INFINITY;

    for await (const row of rows) {
      const window: GrantWindow = {
        node: row.node_id,
        from: row.effective_from ? Date.parse(row.effective_from) : null,
        to: row.effective_to ? Date.parse(row.effective_to) : null,
      };

      for (const edge of [window.from, window.to]) {
        if (edge !== null && edge > now && edge < boundary) {
          boundary = edge;
        }
      }

      const windows = roots.get(row.permission);

      if (windows) {
        windows.push(window);
      } else {
        roots.set(row.permission, [window]);
      }
    }

    const holdings: Holdings = { roots, denies };

    // Invalidated while it was read: the answer goes to the caller that was
    // waiting, but is not kept, since it may predate the change.
    if (stillCurrent()) {
      this.grants.set(subjectKey(type, identityId), {
        holdings,
        expiresAt: Math.min(now + this.ttlMs, boundary),
      });
    }

    return holdings;
  }

  private async treeEntry(): Promise<TreeEntry> {
    if (this.tree && this.tree.expiresAt > this.now()) {
      return this.tree;
    }

    if (this.pendingTree) {
      return this.pendingTree;
    }

    const read: Promise<TreeEntry> = this.fetchTree().finally(() => {
      if (this.pendingTree === read) {
        this.pendingTree = undefined;
      }
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
  private async fetchTree(): Promise<TreeEntry> {
    this.stats.treeRequests += 1;

    const held = this.tree;
    const generation = this.treeGeneration;

    let first = await this.parentsFirstPage(held?.etag ?? undefined);

    if (!first.modified) {
      if (held) {
        this.stats.treeNotModified += 1;

        const renewed = { ...held, expiresAt: this.now() + this.ttlMs };

        if (generation === this.treeGeneration) {
          this.tree = renewed;
        }

        return renewed;
      }

      // A `304` to a request that carried no validator has nothing to keep.
      return this.keepTree([], null, generation);
    }

    for (let walk = 1; ; walk++) {
      const edges = await this.parentsRemainingPages(first.data);

      // One page is one response, so it cannot have been torn; without a
      // validator there is nothing to confirm with.
      if (!spansPages(first.data) || first.etag === null) {
        return this.keepTree(edges, first.etag, generation);
      }

      const confirm = await this.parentsFirstPage(first.etag);

      if (!confirm.modified) {
        return this.keepTree(edges, first.etag, generation);
      }

      if (walk >= MAX_TREE_WALKS) {
        // Still changing. Keep the latest walk, but with no validator, so the
        // next refresh reads every page again rather than revalidating a map
        // that may be missing a node.
        return this.keepTree(edges, null, generation);
      }

      first = confirm;
    }
  }

  private parentsFirstPage(
    etag: string | undefined,
  ): Promise<ConditionalResult<ParentPage>> {
    this.stats.treePages += 1;

    return this.client
      .requestConditional<ParentPage>("GET", PARENTS_PATH, etag, {
        ...this.readOptions,
        query: { page: 1, take: PAGE_SIZE },
      })
      .then((result) => {
        // A `304` carries no body; it confirms edges already checked.
        if (result.modified) {
          understood(result.data, PARENTS_PATH);
        }

        return result;
      });
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

        return this.client
          .request<ParentPage>("GET", PARENTS_PATH, {
            ...this.readOptions,
            query,
          })
          .then((page) => understood(page, PARENTS_PATH));
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
    generation: number,
  ): TreeEntry {
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
    const children = new Map<string, string[]>();

    for (const edge of edges) {
      const parent =
        edge.parent_node_id === null || edge.parent_node_id === undefined
          ? null
          : (ids.get(edge.parent_node_id) ?? edge.parent_node_id);

      parents.set(edge.id, parent);

      if (parent !== null) {
        const siblings = children.get(parent);

        if (siblings) {
          siblings.push(edge.id);
        } else {
          children.set(parent, [edge.id]);
        }
      }
    }

    const entry: TreeEntry = {
      parents,
      children,
      etag,
      expiresAt: this.now() + this.ttlMs,
    };

    // Invalidated while the walk ran: answer from it, but do not keep it.
    if (generation === this.treeGeneration) {
      this.tree = entry;
    }

    return entry;
  }
}

/**
 * Whether a first page says more follow. An empty page ends the walk however
 * the server describes it, as the paginator's own loop does.
 */
function spansPages(first: ParentPage): boolean {
  return first.pagination.has_next_page && first.items.length > 0;
}
