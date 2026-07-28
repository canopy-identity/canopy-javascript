import type { CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import type { QueryParams, RequestBody, ResponseBody } from "../schema.js";

/**
 * Role grants: which identity holds which role, at which node.
 *
 * A grant at a node applies to every descendant, which is what makes one
 * assignment cover a whole branch.
 */
export class Assignments {
  constructor(private readonly client: CanopyClient) {}

  /** Every assignment in the Application, across all nodes. */
  list(
    query: QueryParams<"ApiAssignmentsController_listAppWideAssignments"> = {},
  ): Paginator<AssignmentItem> {
    return paginate<AssignmentItem>(
      (params) =>
        this.client.request("GET", "/api/v1/assignments/app-wide", {
          query: params,
        }),
      { ...query },
    );
  }

  /**
   * Grant a role at a node.
   *
   * Not retried automatically on a 5xx: a repeat could create a second grant,
   * and the server cannot tell the two apart. If the call fails without an
   * answer, read the current assignments before retrying.
   */
  create(
    input: RequestBody<"ApiAssignmentsController_assignRole">,
  ): Promise<ResponseBody<"ApiAssignmentsController_assignRole">> {
    return this.client.request("POST", "/api/v1/assignments", { body: input });
  }

  update(
    id: string,
    input: RequestBody<"ApiAssignmentsController_updateAssignment">,
  ): Promise<ResponseBody<"ApiAssignmentsController_updateAssignment">> {
    return this.client.request(
      "PATCH",
      `/api/v1/assignments/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/assignments/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Grant many at once. Answers 207 with a per-item result rather than failing
   * the batch, so inspect `results` — a 2xx here does not mean every grant
   * succeeded.
   */
  bulkCreate(
    input: RequestBody<"ApiAssignmentsController_bulkCreate">,
  ): Promise<ResponseBody<"ApiAssignmentsController_bulkCreate">> {
    return this.client.request("POST", "/api/v1/assignments/bulk-create", {
      body: input,
    });
  }

  /** Same partial-success contract as `bulkCreate`. */
  bulkRemove(
    input: RequestBody<"ApiAssignmentsController_bulkRemove">,
  ): Promise<ResponseBody<"ApiAssignmentsController_bulkRemove">> {
    return this.client.request("POST", "/api/v1/assignments/bulk-remove", {
      body: input,
    });
  }

  /** Same partial-success contract as `bulkCreate`. */
  bulkChangeRole(
    input: RequestBody<"ApiAssignmentsController_bulkChangeRole">,
  ): Promise<ResponseBody<"ApiAssignmentsController_bulkChangeRole">> {
    return this.client.request("POST", "/api/v1/assignments/bulk-change-role", {
      body: input,
    });
  }
}

export type AssignmentItem = ItemOf<
  ResponseBody<"ApiAssignmentsController_listAppWideAssignments">
>;

type ItemOf<T> = T extends { items: (infer Item)[] } ? Item : never;
