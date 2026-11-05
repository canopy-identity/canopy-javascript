import { SetMetadata } from "@nestjs/common";

import { CANOPY_ALLOW_DELEGATED_TOKENS } from "./tokens.js";

/**
 * Admit a machine client acting for a person on this route or controller.
 *
 * A machine client with token exchange on trades a signed-in person's access
 * token for a `delegated` one: `sub` is the person, `act.sub` the client.
 * `CanopyTokenGuard` refuses such a token everywhere else, so a route never
 * lets an agent act for someone by accident. Here it is accepted beside the
 * types the verifier already allows, and `CanopyGuard` allows the request
 * only when the person and the client both hold the permission.
 *
 * ```ts
 * @UseGuards(CanopyTokenGuard, CanopyGuard)
 * @AllowDelegatedTokens()
 * @RequirePermission("deals.read", { scope: "org" })
 * @Get()
 * list() {}
 * ```
 *
 * The verifier holds a delegated token to `verify.serviceAudience`, as it
 * does a service token. Read `request.canopyToken.act?.sub` in the handler
 * to record which client acted.
 */
export const AllowDelegatedTokens = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CANOPY_ALLOW_DELEGATED_TOKENS, true);
