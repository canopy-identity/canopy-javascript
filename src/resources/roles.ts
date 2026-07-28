import type { CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import type { QueryParams, RequestBody, ResponseBody } from "../schema.js";

/** Named bundles of permissions. */
export class Roles {
  constructor(private readonly client: CanopyClient) {}

  /**
   * `query` is required only because the published spec marks
   * `include_inactive` and `type` as required query parameters. The controller
   * declares both optional, so this is a spec inaccuracy rather than a real
   * constraint — it will relax to optional here the moment the spec is
   * corrected and the types are regenerated. Kept faithful to the spec on
   * purpose: one source of truth beats a hand-written signature that quietly
   * disagrees with it.
   */
  list(
    query: QueryParams<"ApiRolesController_listRoles">,
  ): Paginator<RoleItem> {
    return paginate<RoleItem>(
      (params) =>
        this.client.request("GET", "/api/v1/roles", { query: params }),
      { ...query },
    );
  }

  get(id: string): Promise<ResponseBody<"ApiRolesController_getRole">> {
    return this.client.request(
      "GET",
      `/api/v1/roles/${encodeURIComponent(id)}`,
    );
  }

  create(
    input: RequestBody<"ApiRolesController_createRole">,
  ): Promise<ResponseBody<"ApiRolesController_createRole">> {
    return this.client.request("POST", "/api/v1/roles", { body: input });
  }

  update(
    id: string,
    input: RequestBody<"ApiRolesController_updateRole">,
  ): Promise<ResponseBody<"ApiRolesController_updateRole">> {
    return this.client.request(
      "PATCH",
      `/api/v1/roles/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/roles/${encodeURIComponent(id)}`,
    );
  }

  permissions(
    id: string,
  ): Promise<ResponseBody<"ApiRolesController_getRolePermissions">> {
    return this.client.request(
      "GET",
      `/api/v1/roles/${encodeURIComponent(id)}/permissions`,
    );
  }

  /**
   * Replaces the role's permissions wholesale — this is a PUT, so anything
   * absent from `input` is removed. Read `permissions` first if you mean to add.
   */
  setPermissions(
    id: string,
    input: RequestBody<"ApiRolesController_setRolePermissions">,
  ): Promise<ResponseBody<"ApiRolesController_setRolePermissions">> {
    return this.client.request(
      "PUT",
      `/api/v1/roles/${encodeURIComponent(id)}/permissions`,
      { body: input },
    );
  }
}

export type RoleItem = ItemOf<ResponseBody<"ApiRolesController_listRoles">>;

type ItemOf<T> = T extends { items: (infer Item)[] } ? Item : never;
