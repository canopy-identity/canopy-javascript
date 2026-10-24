import { SetMetadata } from "@nestjs/common";

import { CANOPY_ALLOW_SERVICE_TOKENS } from "./tokens.js";

/**
 * Admit a machine client's token on this route or controller.
 *
 * A machine client obtains a token for itself with the `client_credentials`
 * grant; its `type` is `service` and its `sub` is the client's `client_id`.
 * `CanopyTokenGuard` refuses such a token everywhere else, so a route built
 * for people never admits a machine by accident. Here it is accepted beside
 * the types the verifier already allows, and `CanopyGuard` authorizes it from
 * the client's own grants.
 *
 * ```ts
 * @UseGuards(CanopyTokenGuard, CanopyGuard)
 * @AllowServiceTokens()
 * @RequirePermission("orders.import", { scope: "org" })
 * @Post("import")
 * import() {}
 * ```
 *
 * Read `request.canopyToken.type` in the handler when people and machines
 * should be treated differently.
 */
export const AllowServiceTokens = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CANOPY_ALLOW_SERVICE_TOKENS, true);
