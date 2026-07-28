/**
 * Injection tokens.
 *
 * These are strings rather than classes because esbuild does not emit
 * `design:paramtypes`, so nothing here can be injected by constructor type
 * alone — every dependency is named with an explicit `@Inject`.
 */

/** The resolved `CanopyModuleOptions`. */
export const CANOPY_OPTIONS = "CANOPY_OPTIONS";

/** The configured `Canopy` client. */
export const CANOPY_CLIENT = "CANOPY_CLIENT";

/** Metadata key holding what `@RequirePermission` recorded on a handler. */
export const CANOPY_PERMISSION = "CANOPY_PERMISSION";
