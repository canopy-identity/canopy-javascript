/**
 * `@canopy-io/node` — the official TypeScript client for Canopy.
 *
 * Types are generated from Canopy's published OpenAPI document, so every
 * request and response shape here is the one the API actually serves.
 * See `scripts/generate-types.ts`.
 */

export { Canopy } from "./canopy.js";

export { CanopyClient, isCursorPagination } from "./client.js";
export type {
  CallOptions,
  CanopyClientOptions,
  Collection,
  CursorPagination,
  OffsetPagination,
  Pagination,
  PartialSuccess,
  RequestOptions,
} from "./client.js";

export { paginate, Paginator } from "./pagination.js";
export type { PageFetcher, PageParams, PaginateOptions } from "./pagination.js";

export {
  CanopyConnectionError,
  CanopyError,
  isCanopyConnectionError,
  isCanopyError,
} from "./errors.js";
export type { CanopyErrorBody } from "./errors.js";

export { Assignments } from "./resources/assignments.js";
export type { AssignmentItem } from "./resources/assignments.js";
export { Identities } from "./resources/identities.js";
export type {
  IdentityAssignmentItem,
  IdentityItem,
} from "./resources/identities.js";
export { Permissions } from "./resources/permissions.js";
export type { PermissionItem } from "./resources/permissions.js";
export { Roles } from "./resources/roles.js";
export type { RoleItem } from "./resources/roles.js";

export { withConcurrency } from "./schema.js";
export type {
  ConcurrencyOptions,
  OperationId,
  QueryParams,
  RequestBody,
  ResponseBody,
  Schema,
} from "./schema.js";

export type { components, operations, paths } from "./generated/types.js";
