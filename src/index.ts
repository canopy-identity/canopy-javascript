/**
 * `@canopy-io/sdk` — the official TypeScript client for Canopy.
 *
 * Types are generated from Canopy's published OpenAPI document, so every
 * request and response shape here is the one the API actually serves.
 * See `scripts/generate-types.ts`.
 */

export { CanopyClient, isCursorPagination } from "./client.js";
export type {
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

export type { components, operations, paths } from "./generated/types.js";
