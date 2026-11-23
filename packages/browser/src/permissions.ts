import { CanopyAuthError, CanopyConnectionError } from "./errors.js";

/** One question about the signed-in person's own permission. */
export interface PermissionCheck {
  /** The permission key, for example `deals.read`. */
  permission: string;
  /**
   * The node to ask at, walking its ancestors. Without one, the question is
   * whether the person holds the permission anywhere in the Environment.
   */
  nodeId?: string;
}

/**
 * What the client knows about one check. A wrapper shows a gated control only
 * on `allowed`: `loading` and `error` hide it, so nothing flashes into view
 * that the person cannot use.
 */
export type PermissionState =
  | { status: "loading" }
  | { status: "allowed" }
  | { status: "denied"; reason: string | null }
  | { status: "error"; error: CanopyAuthError | CanopyConnectionError };

/** The access token claims the permission client answers from. */
export interface PermissionClaims {
  permissions?: string[];
  permissions_overflow?: boolean;
  org_id?: string;
  org_permissions?: string[];
  org_permissions_overflow?: boolean;
}

interface Deps {
  /** The API origin: the issuer's. */
  apiOrigin: () => string;
  /** A current access token, or null when nobody is signed in. */
  accessToken: () => Promise<string | null>;
  claims: () => PermissionClaims | null;
  fetch: typeof globalThis.fetch;
  now: () => number;
  changed: () => void;
}

interface Decision {
  allowed: boolean;
  denial_reason: string | null;
}

/** The most checks one evaluate request carries; the API refuses more. */
export const EVALUATE_MAX_CHECKS = 100;

/**
 * How long a failed check waits before a new call may ask again. A failure is
 * kept rather than retried on every render, so a page that renders often
 * cannot turn an outage or a rate limit into a stream of requests.
 */
export const FAILED_CHECK_RETRY_MS = 30_000;

const LOADING: PermissionState = Object.freeze({ status: "loading" });
const ALLOWED: PermissionState = Object.freeze({ status: "allowed" });
const DENIED_BY_TOKEN: PermissionState = Object.freeze({
  status: "denied",
  reason: "not_in_token",
});

interface Held {
  state: PermissionState;
  /** Settles with the answer; shared by every caller of the same check. */
  answer: Promise<boolean>;
  /** For an error: when a new call may ask again. */
  retryAt?: number;
}

interface Queued {
  check: PermissionCheck;
  key: string;
  settle: (allowed: boolean) => void;
  fail: (error: unknown) => void;
}

/**
 * The person's permission checks, answered from the access token where it
 * can, else by the API, and held until the token changes.
 *
 * Every end user's browser calls this, so its cost is the product's cost
 * (`docs/GRANTS_AND_COST_CHECKS.md`, rule 8 in the Canopy repository). Checks
 * asked for in the same tick go in one request, a check already held or on
 * its way is never sent again, and nothing is re-read on a timer: answers last
 * until the access token is refreshed (about 15 minutes), the organization
 * changes or the person signs out. Holding them for less, as a server holds
 * grants for 60 seconds, would multiply the requests a person makes. A
 * permission removed meanwhile can leave a control showing until then; the
 * checks decide what a page shows, and the application's API still refuses
 * the action.
 */
export class PermissionChecks {
  readonly #deps: Deps;
  readonly #held = new Map<string, Held>();

  #queue: Queued[] = [];
  #flushing = false;
  #generation = 0;
  #listed: Promise<string[]> | undefined;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** What is known about a check now, without asking. Stable until it changes. */
  state(check: PermissionCheck): PermissionState {
    const fromToken = this.#fromToken(check);

    if (fromToken) {
      return fromToken;
    }

    return this.#held.get(keyOf(check))?.state ?? LOADING;
  }

  /** Whether the person holds the permission, asking the API only when needed. */
  check(check: PermissionCheck): Promise<boolean> {
    const fromToken = this.#fromToken(check);

    if (fromToken) {
      return Promise.resolve(fromToken.status === "allowed");
    }

    const key = keyOf(check);
    const held = this.#held.get(key);

    if (
      held &&
      !(held.retryAt !== undefined && held.retryAt <= this.#deps.now())
    ) {
      return held.answer;
    }

    let settle!: (allowed: boolean) => void;
    let fail!: (error: unknown) => void;

    const answer = new Promise<boolean>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // A caller that only reads the state never awaits this promise; a
    // failure is recorded in the state, so it is not left unhandled.
    answer.catch(() => undefined);

    this.#held.set(key, { state: LOADING, answer });
    this.#queue.push({ check, key, settle, fail });
    this.#schedule();

    return answer;
  }

  /** Every permission key the person holds anywhere in the Environment. */
  list(): Promise<string[]> {
    this.#listed ??= this.#readList().catch((caught: unknown) => {
      this.#listed = undefined;

      throw caught;
    });

    return this.#listed;
  }

  /** Forget every answer: the token changed, or nobody is signed in. */
  clear(): void {
    this.#generation += 1;
    this.#listed = undefined;

    // Checks still queued have not been sent; they are asked with the new
    // token when the queue flushes, so they stay.
    if (this.#held.size > 0) {
      this.#held.clear();
      this.#deps.changed();
    }
  }

  /**
   * The answer the token itself gives, when it gives one: an Environment-wide
   * check from `permissions`, a check at the token's organization from
   * `org_permissions`. A key on the list is held; a key off a list that did
   * not overflow is not. Off a list that overflowed, the token cannot say.
   */
  #fromToken(check: PermissionCheck): PermissionState | undefined {
    const claims = this.#deps.claims();

    if (!claims) {
      return undefined;
    }

    if (check.nodeId === undefined) {
      return answerFrom(
        claims.permissions,
        claims.permissions_overflow,
        check.permission,
      );
    }

    if (claims.org_id !== undefined && check.nodeId === claims.org_id) {
      return answerFrom(
        claims.org_permissions,
        claims.org_permissions_overflow,
        check.permission,
      );
    }

    return undefined;
  }

  #schedule(): void {
    if (this.#flushing) {
      return;
    }

    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      void this.#flush();
    });
  }

  async #flush(): Promise<void> {
    const batch = this.#queue;

    this.#queue = [];

    if (batch.length === 0) {
      return;
    }

    let token: string | null;

    try {
      token = await this.#deps.accessToken();
    } catch (caught) {
      this.#failAll(batch, caught, this.#generation);

      return;
    }

    // Read after the token: a refresh on the way clears the answers, and the
    // ones asked with the new token belong to the new generation.
    const generation = this.#generation;

    if (!token) {
      for (const queued of batch) {
        this.#store(
          queued,
          { allowed: false, denial_reason: "signed_out" },
          generation,
        );
      }

      return;
    }

    for (let start = 0; start < batch.length; start += EVALUATE_MAX_CHECKS) {
      const chunk = batch.slice(start, start + EVALUATE_MAX_CHECKS);

      void this.#evaluate(chunk, token, generation);
    }
  }

  async #evaluate(
    chunk: Queued[],
    token: string,
    generation: number,
  ): Promise<void> {
    try {
      const body = (await this.#request(
        "/v1/identity/auth/me/permissions/evaluate",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            checks: chunk.map(({ check }) =>
              check.nodeId === undefined
                ? { permission: check.permission, scope: "app_wide" }
                : {
                    permission: check.permission,
                    scope: "node",
                    node_id: check.nodeId,
                  },
            ),
          }),
        },
      )) as { items: Decision[] };

      chunk.forEach((queued, index) => {
        this.#store(
          queued,
          body.items[index] ?? { allowed: false, denial_reason: null },
          generation,
        );
      });
    } catch (caught) {
      this.#failAll(chunk, caught, generation);
    }
  }

  #store(queued: Queued, decision: Decision, generation: number): void {
    queued.settle(decision.allowed);

    if (generation !== this.#generation) {
      return;
    }

    const state: PermissionState = decision.allowed
      ? ALLOWED
      : Object.freeze({ status: "denied", reason: decision.denial_reason });
    const held = this.#held.get(queued.key);

    if (held) {
      held.state = state;
    } else {
      this.#held.set(queued.key, {
        state,
        answer: Promise.resolve(decision.allowed),
      });
    }

    this.#deps.changed();
  }

  #failAll(batch: Queued[], caught: unknown, generation: number): void {
    const error =
      caught instanceof CanopyAuthError ||
      caught instanceof CanopyConnectionError
        ? caught
        : new CanopyAuthError("server_error", String(caught));
    const retryAfterMs =
      error instanceof CanopyAuthError && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1000
        : 0;

    for (const queued of batch) {
      queued.fail(error);

      if (generation !== this.#generation) {
        continue;
      }

      const held = this.#held.get(queued.key);

      if (held) {
        held.state = Object.freeze({ status: "error", error });
        held.retryAt =
          this.#deps.now() + Math.max(FAILED_CHECK_RETRY_MS, retryAfterMs);
      }
    }

    if (generation === this.#generation) {
      this.#deps.changed();
    }
  }

  async #readList(): Promise<string[]> {
    const token = await this.#deps.accessToken();

    if (!token) {
      return [];
    }

    const body = (await this.#request(
      "/v1/identity/auth/me/permissions",
      token,
      { method: "GET" },
    )) as { items: string[] };

    return body.items;
  }

  async #request(
    path: string,
    token: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
    const url = `${this.#deps.apiOrigin()}${path}`;
    let response: Response;

    try {
      response = await this.#deps.fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (caught) {
      throw new CanopyConnectionError(url, caught);
    }

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const failure = (
        parsed as { error?: { code?: string; message?: string } }
      ).error;
      const retryAfter = Number(response.headers.get("retry-after"));

      throw new CanopyAuthError(
        failure?.code ?? "server_error",
        failure?.message,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    return parsed;
  }
}

function keyOf(check: PermissionCheck): string {
  return check.nodeId === undefined
    ? `app_wide\u0000${check.permission}`
    : `node\u0000${check.nodeId}\u0000${check.permission}`;
}

function answerFrom(
  held: string[] | undefined,
  overflow: boolean | undefined,
  permission: string,
): PermissionState | undefined {
  if (!Array.isArray(held)) {
    return undefined;
  }

  if (held.includes(permission)) {
    return ALLOWED;
  }

  if (overflow) {
    return undefined;
  }

  return DENIED_BY_TOKEN;
}
