import type { InjectionToken, ModuleMetadata } from "@nestjs/common";

import type { CanopyClientOptions } from "@canopy-io/node";

/**
 * Pulls a value out of the incoming request.
 *
 * Returning nothing is a denial, not an error — see `CanopyGuard`. That is
 * deliberate: a request whose identity cannot be established is exactly the
 * request that must not be allowed through.
 *
 * `TRequest` is a parameter rather than a fixed type because Nest runs on
 * Express and Fastify, and because the interesting fields — `request.user`,
 * a tenant on the session — are put there by the application's own middleware.
 * Pass your request type to `CanopyModule.forRoot<AuthedRequest>(...)` and
 * these resolvers are typed against it.
 */
export type RequestResolver<TRequest> = (
  request: TRequest,
) => string | null | undefined;

/**
 * How the guard turns a request into an authorization question.
 *
 * Everything `CanopyClientOptions` accepts is accepted here too, so the client
 * is configured in the same place as the guard rather than in two.
 */
export interface CanopyModuleOptions<
  TRequest = unknown,
> extends CanopyClientOptions {
  /**
   * Which identity the request is acting as — usually a claim off the verified
   * access token your auth layer already attached.
   */
  resolveIdentity: RequestResolver<TRequest>;

  /**
   * Which hierarchy node the request is touching, for the default `node`
   * scope. Omit it only if every guarded route uses `scope: "app_wide"`;
   * a `node` check with no node resolves to a denial.
   */
  resolveNode?: RequestResolver<TRequest>;

  /**
   * Register the module globally so feature modules need not import it.
   * Defaults to false, matching `@nestjs/config`.
   */
  isGlobal?: boolean;
}

/**
 * The same options, produced by a factory — for when the API key lives behind
 * something injectable such as `ConfigService`.
 *
 * Extends `Pick<ModuleMetadata, "imports">` rather than restating the type,
 * which is how Nest's own `*AsyncOptions` are declared.
 */
export interface CanopyModuleAsyncOptions<TRequest = unknown> extends Pick<
  ModuleMetadata,
  "imports"
> {
  inject?: InjectionToken[];
  useFactory: (
    ...args: never[]
  ) => Promise<CanopyModuleOptions<TRequest>> | CanopyModuleOptions<TRequest>;
  isGlobal?: boolean;
}
