import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  isCanopyAuthorizerError,
  isCanopyError,
  type LocalAuthorizer,
  type RequestBody,
} from "@canopy-io/node";

import type { CanopyModuleOptions } from "./options.js";
import type { PermissionRequirement } from "./require-permission.decorator.js";
import {
  CANOPY_AUTHORIZER,
  CANOPY_OPTIONS,
  CANOPY_PERMISSION,
} from "./tokens.js";

/** Read off the generated operation, so it follows the API rather than restating it. */
type EvaluateQuery = RequestBody<"ApiPermissionsController_evaluate">;

/**
 * Only the verdict, not the API's full explain payload.
 *
 * A decision reached in-process cannot report `granting_roles` or an effective
 * node — that reasoning lives on the server. The guard has never needed it, and
 * typing the narrow thing keeps that honest rather than implying a richer
 * answer than exists.
 */
type Verdict = { allowed: boolean };

interface Cancellation {
  signal: AbortSignal;
  dispose: () => void;
}

/** The Node stream underneath an Express or Fastify response. */
interface ClosableResponse {
  once: (event: string, listener: () => void) => unknown;
  removeListener: (event: string, listener: () => void) => unknown;
  writableEnded?: boolean;
  raw?: ClosableResponse;
}

function isClosable(value: unknown): value is ClosableResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ClosableResponse).once === "function" &&
    typeof (value as ClosableResponse).removeListener === "function"
  );
}

/**
 * Find the Node response stream behind whatever the adapter hands back.
 *
 * `.raw` is checked first and on its own merits, because the object Nest
 * returns is not always the stream. Express returns the `ServerResponse`
 * itself, which listens; Fastify returns a `Reply`, which is a plain object
 * with the real response on `.raw`. Testing the outer object first and
 * returning early on failure would skip `.raw` in exactly the case it exists
 * for.
 */
function resolveStream(response: unknown): ClosableResponse | undefined {
  const raw = (response as { raw?: unknown } | null | undefined)?.raw;

  if (isClosable(raw)) {
    return raw;
  }

  if (isClosable(response)) {
    return response;
  }

  return undefined;
}

/**
 * Enforces `@RequirePermission` by asking Canopy, once, per guarded request.
 *
 * The guard fails closed at every step. An unresolvable identity, a `node`
 * check with no node, a denial, or an unreachable API all end the request —
 * there is no path through this class that allows a request whose decision is
 * unknown. That is the property worth protecting when reading this code: an
 * `allow` must be something Canopy actually said.
 *
 * A route with no requirement is allowed through untouched, so the guard can be
 * applied globally and opted into per route. Registered that way it runs before
 * controller- and route-scoped guards, so whatever authenticates the request has
 * to be registered globally ahead of it — otherwise `resolveIdentity` runs
 * before there is anything to resolve and every guarded route denies.
 */
@Injectable()
export class CanopyGuard implements CanActivate {
  private readonly logger = new Logger(CanopyGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CANOPY_AUTHORIZER) private readonly authorizer: LocalAuthorizer,
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

    const http = context.switchToHttp();
    const request: unknown = http.getRequest();
    const identityId = resolveSafely(this.options.resolveIdentity, request);

    if (!identityId) {
      throw new ForbiddenException(
        "No identity on the request. Canopy cannot evaluate a permission without one.",
      );
    }

    const decision = await this.evaluate(
      requirement,
      identityId,
      request,
      watchDisconnect(http),
    );

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
    cancellation: Cancellation | undefined,
  ): Promise<Verdict> {
    const query = this.buildQuery(requirement, identityId, request);

    try {
      // Answered in-process. The authorizer holds the identity's grant roots
      // and a shared copy of the hierarchy, so the common case reaches no
      // network at all; only a cold or expired entry does, and its deadline
      // and retries are bounded by the same options as before.
      return await this.authorizer.evaluate(
        query,
        cancellation ? { signal: cancellation.signal } : {},
      );
    } catch (error) {
      // The caller hung up mid-check. There is no one left to answer, and this
      // is not Canopy failing — so it must not be logged or reported as though
      // it were. Rethrowing the abort ends the request without inventing a
      // decision.
      if (cancellation?.signal.aborted) {
        throw error;
      }

      // Deliberately not re-thrown as-is: a failure here must not reach the
      // client as though Canopy had answered.
      this.logger.error(
        `Could not evaluate ${requirement.permission} for ${identityId}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw this.toHttpException(error);
    } finally {
      cancellation?.dispose();
    }
  }

  /**
   * Turn a failed check into the status that describes it.
   *
   * Every branch denies — nothing here can let a request through — but they say
   * different things, and the difference is what makes an incident diagnosable.
   * Reporting a rejected API key as "temporarily unavailable" invites a retry
   * that will never succeed and hides a misconfiguration behind an outage.
   */
  private toHttpException(error: unknown): Error {
    // The authorizer could not see far enough to decide — a credential that
    // cannot read the hierarchy, most likely. Not an outage: no retry fixes a
    // missing scope, and reporting it as one would bury a misconfiguration
    // under what looks like a blip.
    if (isCanopyAuthorizerError(error)) {
      return new InternalServerErrorException(
        `Authorization is misconfigured: ${error.message}`,
      );
    }

    if (!isCanopyError(error)) {
      // Never answered: unreachable, reset, or past the deadline.
      return new ServiceUnavailableException(
        "Authorization is temporarily unavailable.",
      );
    }

    // Canopy rejected our own credential. No retry fixes this.
    if (error.isAuthFailure) {
      return new InternalServerErrorException(
        "Authorization is misconfigured. Check the Canopy API key and its scopes.",
      );
    }

    // A 404 with no error code is Nest's own "no such route", which here means
    // this Canopy does not serve the endpoint the authorizer reads — an SDK
    // newer than the API it is pointed at. Denying would be catastrophic and
    // silent: every guarded route in the application would answer 403 with
    // nothing to suggest the cause is a version mismatch rather than policy.
    if (error.statusCode === 404 && error.code === null) {
      return new InternalServerErrorException(
        `Authorization is misconfigured: ${error.request.method} ${error.request.path} is not served by this Canopy. ` +
          "The SDK requires an API that exposes the identity grants endpoint.",
      );
    }

    // A 404 that does carry a code is a real answer — the identity is not in
    // this Environment. Deny rather than 500, the guard's whole thesis being
    // that an undecidable request does not proceed, but say nothing about what
    // was missing.
    if (error.statusCode === 404) {
      return new ForbiddenException("Could not evaluate the permission.");
    }

    if (error.isRateLimited || error.statusCode >= 500) {
      return new ServiceUnavailableException(
        "Authorization is temporarily unavailable.",
      );
    }

    // A 4xx we did not anticipate is a malformed question — our bug, not a
    // transient condition.
    return new InternalServerErrorException(
      "Authorization could not be evaluated.",
    );
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

    const nodeId = this.options.resolveNode
      ? resolveSafely(this.options.resolveNode, request)
      : undefined;

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

/**
 * Run a resolver, treating a throw as "could not resolve".
 *
 * Resolvers reach into the request — `request.user.sub` is the shape the docs
 * suggest and the one most applications write. On an unauthenticated request
 * `request.user` is undefined and that expression throws, which without this
 * would surface as a 500. An identity that cannot be established is exactly the
 * request that must be denied, so it becomes the same 403 as returning nothing.
 */
function resolveSafely(
  resolve: (request: never) => string | null | undefined,
  request: unknown,
): string | null | undefined {
  try {
    return (resolve as (request: unknown) => string | null | undefined)(
      request,
    );
  } catch {
    return undefined;
  }
}

/**
 * Abort the permission check if the caller hangs up while it is in flight.
 *
 * Watches the *response*, not the request. A request stream emits `close` on
 * every normal request once its body has been read, so listening there would
 * abort perfectly healthy checks; a response emits `close` before
 * `writableEnded` only when nothing was ever sent — which is exactly the
 * disconnect case. The `writableEnded` re-check at fire time keeps that true
 * even if the ordering differs by adapter.
 *
 * Returns undefined for a transport with no such response — a GraphQL or
 * microservice context — where the check simply runs to its deadline.
 */
function watchDisconnect(http: {
  getResponse?: () => unknown;
}): Cancellation | undefined {
  const raw = resolveStream(http.getResponse?.());

  if (!raw) {
    return undefined;
  }

  const controller = new AbortController();

  const onClose = () => {
    if (raw.writableEnded === true) {
      return;
    }

    controller.abort(
      new DOMException("The client closed the request", "AbortError"),
    );
  };

  raw.once("close", onClose);

  return {
    signal: controller.signal,
    dispose: () => raw.removeListener("close", onClose),
  };
}
