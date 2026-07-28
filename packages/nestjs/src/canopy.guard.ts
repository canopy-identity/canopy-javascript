import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { Canopy, RequestBody, ResponseBody } from "@canopy-io/node";

/** Read off the generated operation, so it follows the API rather than restating it. */
type EvaluateQuery = RequestBody<"ApiPermissionsController_evaluate">;
type EvaluateDecision = ResponseBody<"ApiPermissionsController_evaluate">;

import type { CanopyModuleOptions } from "./options.js";
import type { PermissionRequirement } from "./require-permission.decorator.js";
import { CANOPY_CLIENT, CANOPY_OPTIONS, CANOPY_PERMISSION } from "./tokens.js";

/**
 * Enforces `@RequirePermission` by asking Canopy, once, per guarded request.
 *
 * The guard fails closed at every step. An unresolvable identity, a `node`
 * check with no node, a denial, or an unreachable API all end the request —
 * there is no path through this class that allows a request whose decision is
 * unknown. That is the property worth protecting when reading this code: an
 * `allow` must be something Canopy actually said.
 *
 * A route with no requirement is allowed through untouched, so the guard is
 * safe to apply globally and opt into per route.
 */
@Injectable()
export class CanopyGuard implements CanActivate {
  private readonly logger = new Logger(CanopyGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CANOPY_CLIENT) private readonly canopy: Canopy,
    @Inject(CANOPY_OPTIONS)
    private readonly options: CanopyModuleOptions<unknown>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(CANOPY_PERMISSION, [context.getHandler(), context.getClass()]);

    if (!requirement) {
      return true;
    }

    const request: unknown = context.switchToHttp().getRequest();
    const identityId = this.options.resolveIdentity(request);

    if (!identityId) {
      throw new ForbiddenException(
        "No identity on the request. Canopy cannot evaluate a permission without one.",
      );
    }

    const decision = await this.evaluate(requirement, identityId, request);

    if (!decision.allowed) {
      throw new ForbiddenException(
        `Identity does not hold ${requirement.permission}.`,
      );
    }

    return true;
  }

  /**
   * Asks Canopy the question the decorator recorded.
   *
   * Every failure is converted into a thrown exception rather than a `false`
   * decision, so a caller cannot mistake "we could not tell" for "denied by
   * policy" — and neither outcome lets the request proceed.
   */
  private async evaluate(
    requirement: PermissionRequirement,
    identityId: string,
    request: unknown,
  ): Promise<EvaluateDecision> {
    const query = this.buildQuery(requirement, identityId, request);

    try {
      return await this.canopy.permissions.evaluate(query);
    } catch (error) {
      // Deliberately not re-thrown as-is: a transport failure must not reach
      // the client as though Canopy had answered.
      this.logger.error(
        `Could not evaluate ${requirement.permission} for ${identityId}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new ServiceUnavailableException(
        "Authorization is temporarily unavailable.",
      );
    }
  }

  private buildQuery(
    requirement: PermissionRequirement,
    identityId: string,
    request: unknown,
  ): EvaluateQuery {
    if (requirement.scope === "app_wide") {
      return {
        identity_id: identityId,
        permission: requirement.permission,
        scope: "app_wide",
      };
    }

    const nodeId = this.options.resolveNode?.(request);

    if (!nodeId) {
      throw new ForbiddenException(
        `No node on the request. ${requirement.permission} is checked at a node; configure resolveNode, or declare the route as app_wide if that is genuinely the question.`,
      );
    }

    return {
      identity_id: identityId,
      permission: requirement.permission,
      scope: "node",
      node_id: nodeId,
    };
  }
}
