import type { CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import { withConcurrency } from "../schema.js";
import type {
  ConcurrencyOptions,
  QueryParams,
  RequestBody,
  ResponseBody,
} from "../schema.js";

/** Named bundles of permissions. */
export class Roles {
  constructor(private readonly client: CanopyClient) {}

  list(
    query: QueryParams<"ApiRolesController_listRoles"> = {},
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

  /**
   * Pass `ifMatch` with the role's current `version` to make a
   * read-modify-write safe — a concurrent edit answers 409 instead of being
   * silently overwritten.
   */
  update(
    id: string,
    input: RequestBody<"ApiRolesController_updateRole">,
    options: ConcurrencyOptions = {},
  ): Promise<ResponseBody<"ApiRolesController_updateRole">> {
    return this.client.request(
      "PATCH",
      `/api/v1/roles/${encodeURIComponent(id)}`,
      { body: input, ...withConcurrency(options) },
    );
  }

  delete(id: string, options: ConcurrencyOptions = {}): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/roles/${encodeURIComponent(id)}`,
      withConcurrency(options),
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
