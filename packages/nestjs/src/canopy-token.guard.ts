import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  type CanopyTokenClaims,
  isCanopyTokenError,
  tokenErrorStatus,
  TokenVerifier,
} from "@canopy-io/node";

import type { CanopyModuleOptions } from "./options.js";
import {
  CANOPY_ALLOW_SERVICE_TOKENS,
  CANOPY_OPTIONS,
  CANOPY_TOKEN_VERIFIER,
} from "./tokens.js";

/**
 * Verifies the bearer token and attaches its claims to the request.
 *
 * This is the authentication half, and it is opt-in on purpose. `CanopyGuard`
 * answers "may this identity do this?"; something has to have established
 * *which* identity first, and `resolveIdentity` says as much — "usually a
 * claim off the verified access token your auth layer already attached".
 *
 * Use this guard when Canopy issues your tokens and you have no auth layer
 * yet. Skip it entirely if you already run Passport or your own JWT
 * middleware — it is additive, and nothing else in the package depends on it.
 *
 * ```ts
 * @UseGuards(CanopyTokenGuard, CanopyGuard)
 * @RequirePermission("documents.read")
 * findAll() {}
 * ```
 *
 * Order matters: this must run first, because `CanopyGuard` reads what it
 * attaches. Nest runs guards left to right, so listing them in that order is
 * the whole of the wiring.
 *
 * Claims land on `request.canopyToken` by default, which is why
 * `resolveIdentity` is usually `(req) => req.canopyToken?.sub`. The property
 * is configurable so it cannot collide with a `request.user` an existing
 * middleware already owns.
 *
 * A machine client's `service` token is refused unless the route or its
 * controller carries `@AllowServiceTokens()`: a route built for people must
 * not admit a machine by accident.
 */
@Injectable()
export class CanopyTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CANOPY_TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(CANOPY_OPTIONS)
    private readonly options: CanopyModuleOptions<unknown>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      [key: string]: unknown;
    }>();

    const token = readBearerToken(request.headers?.["authorization"]);

    if (token === null) {
      throw new UnauthorizedException(
        "Missing bearer token in the Authorization header.",
      );
    }

    const admitsServiceTokens =
      this.reflector.getAllAndOverride<boolean | undefined>(
        CANOPY_ALLOW_SERVICE_TOKENS,
        [context.getHandler(), context.getClass()],
      ) === true;

    let claims: CanopyTokenClaims;

    try {
      claims = await this.verifier.verify(
        token,
        admitsServiceTokens ? { alsoAllow: ["service"] } : {},
      );
    } catch (error) {
      // Not being able to verify is not the same as failing to verify. When
      // the key set cannot be read the caller's token may be perfectly good —
      // we simply cannot say — so this is ours to own, exactly as the
      // permission guard answers 503 rather than denying on an undecidable
      // check.
      //
      // Reporting it as 401 would be worse than merely inaccurate: a client
      // reads 401 as "your token is stale", discards a valid one and asks for
      // another, which aims a refresh storm at the issuer that is already
      // down. And an outage that only ever emits 4xx is invisible to anything
      // watching 5xx.
      if (!isCanopyTokenError(error)) {
        throw error;
      }

      const { status, message } = tokenErrorStatus(error);

      if (status === 503) {
        throw new ServiceUnavailableException(message, { cause: error });
      }

      // Every other cause is the token itself, and a 401 whatever the detail:
      // the caller cannot fix a bad signature by being granted something. The
      // specific code stays on the error for logs rather than going to the
      // caller, who has no use for the difference and should not be told which
      // check failed.
      throw new UnauthorizedException(message, { cause: error });
    }

    request[this.options.attachTokenAs ?? "canopyToken"] = claims;

    return true;
  }
}

/**
 * The token out of an `Authorization: Bearer …` header.
 *
 * Returns null rather than throwing so the caller owns the message. The scheme
 * is matched case-insensitively because RFC 7235 says it is case-insensitive,
 * and clients do send `bearer`.
 */
function readBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value !== "string") {
    return null;
  }

  // Split by hand rather than with `/^bearer\s+(.+)$/i`: the header is the
  // caller's to write, and that pattern backtracks on a long run of spaces.
  const trimmed = value.trim();
  const scheme = trimmed.slice(0, 6);
  const separator = trimmed.charAt(6);

  if (scheme.toLowerCase() !== "bearer" || !/\s/.test(separator)) {
    return null;
  }

  const token = trimmed.slice(7).trim();

  return token.length > 0 ? token : null;
}
