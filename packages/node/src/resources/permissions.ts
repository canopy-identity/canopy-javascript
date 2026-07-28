import type { CallOptions, CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import { withConcurrency } from "../schema.js";
import type {
  ConcurrencyOptions,
  QueryParams,
  RequestBody,
  ResponseBody,
} from "../schema.js";

/**
 * Permissions, and the authorization decision itself.
 *
 * `evaluate` is the call an integrator makes on every request, so it is the one
 * worth reading first.
 */
export class Permissions {
  constructor(private readonly client: CanopyClient) {}

  /**
   * Ask whether an identity holds a permission.
   *
   * With `scope: "node"` the engine walks the node's lineage, so a permission
   * granted on an ancestor is inherited at `node_id`. With `scope: "app_wide"`
   * it answers the coarse "anywhere in this Application" question and returns
   * `effective_node_id: null` — that answer must never be used to guard a
   * resource that belongs to a specific node, which is why the scope is a
   * required field rather than a default.
   *
   * This runs on the request path, so it is the call most worth passing
   * `signal` and a tight `timeoutMs` to: without them a slow answer here holds
   * an inbound request open for the client-wide deadline on every attempt.
   */
  evaluate(
    input: RequestBody<"ApiPermissionsController_evaluate">,
    options: CallOptions = {},
  ): Promise<ResponseBody<"ApiPermissionsController_evaluate">> {
    return this.client.request("POST", "/api/v1/permissions/evaluate", {
      body: input,
      // A POST only because the question travels in a body; it computes a
      // decision and writes nothing, so repeating it is safe — and this is the
      // call least able to afford giving up on a transient 5xx.
      idempotent: true,
      ...options,
    });
  }

  /**
   * Evaluate many decisions in one round trip.
   *
   * Prefer this to a loop over `evaluate` when rendering a screen: the checks
   * are answered together instead of paying request latency for each.
   */
  evaluateBulk(
    input: RequestBody<"ApiPermissionsController_evaluateBulk">,
    options: CallOptions = {},
  ): Promise<ResponseBody<"ApiPermissionsController_evaluateBulk">> {
    return this.client.request("POST", "/api/v1/permissions/evaluate/bulk", {
      body: input,
      /** Read-only, like `evaluate`. */
      idempotent: true,
      ...options,
    });
  }

  /**
   * The same decision with its reasoning — which role granted it, which node
   * it was inherited from. For debugging an unexpected allow or deny, not for
   * the enforcement path.
   */
  explain(
    input: RequestBody<"ApiPermissionsController_explain">,
    options: CallOptions = {},
  ): Promise<ResponseBody<"ApiPermissionsController_explain">> {
    return this.client.request("POST", "/api/v1/permissions/evaluate/explain", {
      body: input,
      /** Read-only, like `evaluate`. */
      idempotent: true,
      ...options,
    });
  }

  /** Every permission in the Environment, page by page. */
  list(
    query: QueryParams<"ApiPermissionsController_listPermissions"> = {},
  ): Paginator<PermissionItem> {
    return paginate<PermissionItem>(
      (params) =>
        this.client.request("GET", "/api/v1/permissions", { query: params }),
      { ...query },
    );
  }

  get(
    id: string,
  ): Promise<ResponseBody<"ApiPermissionsController_getPermission">> {
    return this.client.request(
      "GET",
      `/api/v1/permissions/${encodeURIComponent(id)}`,
    );
  }

  /** Define permissions. The request takes a batch, not a single key. */
  create(
    input: RequestBody<"ApiPermissionsController_createPermissions">,
  ): Promise<ResponseBody<"ApiPermissionsController_createPermissions">> {
    return this.client.request("POST", "/api/v1/permissions", { body: input });
  }

  /**
   * Pass `ifMatch` with the permission's current `version` to make a
   * read-modify-write safe — a concurrent edit answers 409 instead of being
   * silently overwritten.
   */
  update(
    id: string,
    input: RequestBody<"ApiPermissionsController_updatePermission">,
    options: ConcurrencyOptions = {},
  ): Promise<ResponseBody<"ApiPermissionsController_updatePermission">> {
    return this.client.request(
      "PATCH",
      `/api/v1/permissions/${encodeURIComponent(id)}`,
      { body: input, ...withConcurrency(options) },
    );
  }

  delete(id: string, options: ConcurrencyOptions = {}): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/permissions/${encodeURIComponent(id)}`,
      withConcurrency(options),
    );
  }
}

/**
 * One item from the permissions collection.
 *
 * Read off the list response rather than named directly, so it follows the
 * spec instead of being a second declaration of it.
 */
export type PermissionItem = ItemOf<
  ResponseBody<"ApiPermissionsController_listPermissions">
>;

type ItemOf<T> = T extends { items: (infer Item)[] } ? Item : never;
