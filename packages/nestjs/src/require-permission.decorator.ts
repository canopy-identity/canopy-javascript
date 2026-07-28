import { SetMetadata } from "@nestjs/common";

import { CANOPY_PERMISSION } from "./tokens.js";

/**
 * Which question the guard asks Canopy.
 *
 * `node` walks the node's lineage, so a role granted on an ancestor is
 * inherited at the node being touched. `app_wide` asks only whether the
 * identity holds the permission anywhere in the Environment.
 */
export type PermissionScope = "node" | "app_wide";

/** What `@RequirePermission` records for the guard to read back. */
export interface PermissionRequirement {
  readonly permission: string;
  readonly scope: PermissionScope;
}

export interface RequirePermissionOptions {
  /**
   * Defaults to `node`.
   *
   * `app_wide` is opt-in on purpose. It answers a coarser question and returns
   * no effective node, which makes it right for deciding whether to render a
   * menu item and wrong for guarding a resource that belongs to one — a
   * distinction that is easy to get backwards if the looser check is the
   * default.
   */
  readonly scope?: PermissionScope;
}

/**
 * Require a Canopy permission before a route runs.
 *
 * ```ts
 * @UseGuards(CanopyGuard)
 * @RequirePermission("orders.refund")
 * @Post(":orderId/refund")
 * refund() {}
 * ```
 *
 * Applies to a single handler or to a whole controller; a handler's own
 * requirement wins over its controller's.
 */
export const RequirePermission = (
  permission: string,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata<string, PermissionRequirement>(CANOPY_PERMISSION, {
    permission,
    scope: options.scope ?? "node",
  });
