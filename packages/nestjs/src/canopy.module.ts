import { type DynamicModule, Module, type Provider } from "@nestjs/common";

import { Canopy, LocalAuthorizer, TokenVerifier } from "@canopy-io/node";

import { CanopyGuard } from "./canopy.guard.js";
import { CanopyTokenGuard } from "./canopy-token.guard.js";
import type {
  CanopyModuleAsyncOptions,
  CanopyModuleOptions,
} from "./options.js";
import {
  CANOPY_AUTHORIZER,
  CANOPY_CLIENT,
  CANOPY_OPTIONS,
  CANOPY_TOKEN_VERIFIER,
} from "./tokens.js";

/**
 * Wires one configured `Canopy` client and the guard that uses it into a Nest
 * application.
 *
 * ```ts
 * CanopyModule.forRoot<AuthedRequest>({
 *   apiKey: process.env.CANOPY_API_KEY,
 *   resolveIdentity: (request) => request.user?.sub,
 *   resolveNode: (request) => request.params?.orgId,
 * })
 * ```
 *
 * The client is a singleton because it holds no per-request state — it is a
 * `fetch` wrapper with credentials — so there is nothing to gain from building
 * one per request and a connection pool to lose.
 */

/**
 * Per-attempt deadline for a cache miss on the request path.
 *
 * Five seconds rather than the client's 30: this call sits on the request path,
 * so its deadline is time an inbound request spends waiting. An authorization
 * service that has not answered in five seconds is not going to save the
 * request.
 */
const DEFAULT_EVALUATE_TIMEOUT_MS = 5_000;

/**
 * Retries for a cache miss on the request path.
 *
 * One, not the client's two. A deadline bounds an attempt; this bounds how many
 * of them an inbound request can wait through. One retry still absorbs a
 * transient blip, and caps the worst case at roughly two deadlines rather than
 * three.
 */
const DEFAULT_EVALUATE_MAX_RETRIES = 1;

/**
 * The authorizer both registration paths build.
 *
 * The guard's `evaluateTimeoutMs` / `evaluateMaxRetries` still apply, but to
 * far fewer calls: they bound a cache miss rather than every request.
 */
function buildAuthorizer<TRequest>(
  client: Canopy,
  options: CanopyModuleOptions<TRequest>,
): LocalAuthorizer {
  return new LocalAuthorizer(client.client, {
    ...(options.authorizationTtlMs === undefined
      ? {}
      : { ttlMs: options.authorizationTtlMs }),
    timeoutMs: options.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS,
    maxRetries: options.evaluateMaxRetries ?? DEFAULT_EVALUATE_MAX_RETRIES,
  });
}

@Module({})
export class CanopyModule {
  static forRoot<TRequest = unknown>(
    options: CanopyModuleOptions<TRequest>,
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: CANOPY_OPTIONS, useValue: options },
      {
        provide: CANOPY_CLIENT,
        useFactory: () => new Canopy(options),
      },
      {
        provide: CANOPY_TOKEN_VERIFIER,
        useFactory: () => new TokenVerifier(options.verify),
      },
      {
        provide: CANOPY_AUTHORIZER,
        useFactory: (client: Canopy) => buildAuthorizer(client, options),
        inject: [CANOPY_CLIENT],
      },
      CanopyGuard,
      CanopyTokenGuard,
    ];

    return {
      module: CanopyModule,
      global: options.isGlobal ?? false,
      providers,
      exports: [
        CANOPY_CLIENT,
        CANOPY_OPTIONS,
        CANOPY_TOKEN_VERIFIER,
        CANOPY_AUTHORIZER,
        CanopyGuard,
        CanopyTokenGuard,
      ],
    };
  }

  /**
   * The same wiring when the API key comes from something injectable, such as
   * `ConfigService`, rather than being available at module-definition time.
   */
  static forRootAsync<TRequest = unknown>(
    options: CanopyModuleAsyncOptions<TRequest>,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: CANOPY_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: CANOPY_CLIENT,
        useFactory: (resolved: CanopyModuleOptions<TRequest>) =>
          new Canopy(resolved),
        inject: [CANOPY_OPTIONS],
      },
      {
        provide: CANOPY_TOKEN_VERIFIER,
        useFactory: (resolved: CanopyModuleOptions<TRequest>) =>
          new TokenVerifier(resolved.verify),
        inject: [CANOPY_OPTIONS],
      },
      {
        provide: CANOPY_AUTHORIZER,
        useFactory: (client: Canopy, resolved: CanopyModuleOptions<TRequest>) =>
          buildAuthorizer(client, resolved),
        inject: [CANOPY_CLIENT, CANOPY_OPTIONS],
      },
      CanopyGuard,
      CanopyTokenGuard,
    ];

    return {
      module: CanopyModule,
      global: options.isGlobal ?? false,
      // Spread rather than assigned: under exactOptionalPropertyTypes an
      // explicit `imports: undefined` is not the same as no `imports` at all.
      ...(options.imports ? { imports: options.imports } : {}),
      providers,
      exports: [
        CANOPY_CLIENT,
        CANOPY_OPTIONS,
        CANOPY_TOKEN_VERIFIER,
        CANOPY_AUTHORIZER,
        CanopyGuard,
        CanopyTokenGuard,
      ],
    };
  }
}
