import { Inject } from "@nestjs/common";

import { CANOPY_CLIENT } from "./tokens.js";

/**
 * Injects the configured client.
 *
 * ```ts
 * constructor(@InjectCanopy() private readonly canopy: Canopy) {}
 * ```
 *
 * Named rather than resolved by type because this package is bundled with
 * esbuild, which emits no `design:paramtypes` — so type-only injection would
 * fail at runtime with a confusing "cannot resolve dependency" rather than at
 * build time.
 */
export const InjectCanopy = (): ParameterDecorator => Inject(CANOPY_CLIENT);
