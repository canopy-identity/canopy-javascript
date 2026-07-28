/**
 * `@canopy-io/nestjs` — the official NestJS integration for Canopy.
 *
 * Register the module, put `CanopyGuard` on a route, and declare what the
 * route needs with `@RequirePermission`. The guard turns that into a single
 * evaluation against Canopy and fails closed on anything it cannot answer.
 *
 * The client itself is `@canopy-io/node`; inject it with `@InjectCanopy()`
 * for everything the guard does not cover.
 */

export { CanopyModule } from "./canopy.module.js";
export { CanopyGuard } from "./canopy.guard.js";
export { InjectCanopy } from "./inject-canopy.decorator.js";
export { RequirePermission } from "./require-permission.decorator.js";
export type {
  PermissionRequirement,
  PermissionScope,
  RequirePermissionOptions,
} from "./require-permission.decorator.js";
export type {
  CanopyModuleAsyncOptions,
  CanopyModuleOptions,
  RequestResolver,
} from "./options.js";
export { CANOPY_CLIENT, CANOPY_OPTIONS, CANOPY_PERMISSION } from "./tokens.js";

// Re-exported so a consumer can type a service against the client without
// also depending on @canopy-io/node directly.
export type { Canopy } from "@canopy-io/node";
