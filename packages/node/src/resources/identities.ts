import type { CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import type { QueryParams, RequestBody, ResponseBody } from "../schema.js";

/** The end users of your application. */
export class Identities {
  constructor(private readonly client: CanopyClient) {}

  list(
    query: QueryParams<"ApiIdentitiesController_listIdentities"> = {},
  ): Paginator<IdentityItem> {
    return paginate<IdentityItem>(
      (params) =>
        this.client.request("GET", "/api/v1/identities", { query: params }),
      { ...query },
    );
  }

  get(
    id: string,
  ): Promise<ResponseBody<"ApiIdentitiesController_getIdentity">> {
    return this.client.request(
      "GET",
      `/api/v1/identities/${encodeURIComponent(id)}`,
    );
  }

  create(
    input: RequestBody<"ApiIdentitiesController_createIdentity">,
  ): Promise<ResponseBody<"ApiIdentitiesController_createIdentity">> {
    return this.client.request("POST", "/api/v1/identities", { body: input });
  }

  update(
    id: string,
    input: RequestBody<"ApiIdentitiesController_updateIdentity">,
  ): Promise<ResponseBody<"ApiIdentitiesController_updateIdentity">> {
    return this.client.request(
      "PATCH",
      `/api/v1/identities/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/identities/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Deactivation is the reversible counterpart to `delete` — sessions are
   * revoked and sign-in refused, but the identity and its assignments survive.
   * Prefer it for offboarding you may need to undo.
   */
  deactivate(
    id: string,
  ): Promise<ResponseBody<"ApiIdentitiesController_deactivateIdentity">> {
    return this.client.request(
      "POST",
      `/api/v1/identities/${encodeURIComponent(id)}/deactivate`,
    );
  }

  activate(
    id: string,
  ): Promise<ResponseBody<"ApiIdentitiesController_activateIdentity">> {
    return this.client.request(
      "POST",
      `/api/v1/identities/${encodeURIComponent(id)}/activate`,
    );
  }

  /**
   * Every role this identity holds, and where — across all pages.
   *
   * Paginated (20 per page by default), so this returns a `Paginator` rather
   * than one response. Reading a single page here would under-report what an
   * identity can do, which is the dangerous direction to be wrong in.
   *
   * ```ts
   * for await (const assignment of canopy.identities.assignments(id)) { … }
   * ```
   */
  assignments(
    id: string,
    query: QueryParams<"ApiIdentitiesController_getIdentityAssignments"> = {},
  ): Paginator<IdentityAssignmentItem> {
    return paginate<IdentityAssignmentItem>(
      (params) =>
        this.client.request(
          "GET",
          `/api/v1/identities/${encodeURIComponent(id)}/assignments`,
          { query: params },
        ),
      { ...query },
    );
  }

  /**
   * The permissions this identity effectively holds, inheritance resolved.
   *
   * For enforcing a single check, use `permissions.evaluate` — it answers one
   * question at the node that matters. This is for showing a person what
   * someone can do.
   */
  permissions(
    id: string,
  ): Promise<ResponseBody<"ApiIdentitiesController_getIdentityPermissions">> {
    return this.client.request(
      "GET",
      `/api/v1/identities/${encodeURIComponent(id)}/permissions`,
    );
  }
}

export type IdentityItem = ItemOf<
  ResponseBody<"ApiIdentitiesController_listIdentities">
>;

/** One role grant from an identity's assignments collection. */
export type IdentityAssignmentItem = ItemOf<
  ResponseBody<"ApiIdentitiesController_getIdentityAssignments">
>;

type ItemOf<T> = T extends { items: (infer Item)[] } ? Item : never;
