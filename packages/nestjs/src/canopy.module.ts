import { type DynamicModule, Module, type Provider } from "@nestjs/common";

import { Canopy } from "@canopy-io/node";

import { CanopyGuard } from "./canopy.guard.js";
import type {
  CanopyModuleAsyncOptions,
  CanopyModuleOptions,
} from "./options.js";
import { CANOPY_CLIENT, CANOPY_OPTIONS } from "./tokens.js";

/**
 * Wires one configured `Canopy` client and the guard that uses it into a Nest
 * application.
 *
 * ```ts
 * CanopyModule.forRoot<AuthedRequest>({
 *   apiKey: process.env.CANOPY_API_KEY,
 *   resolveIdentity: (request) => request.user.sub,
 *   resolveNode: (request) => request.params.orgId,
 * })
 * ```
 *
 * The client is a singleton because it holds no per-request state — it is a
 * `fetch` wrapper with credentials — so there is nothing to gain from building
 * one per request and a connection pool to lose.
 */
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
      CanopyGuard,
    ];

    return {
      module: CanopyModule,
      global: options.isGlobal ?? false,
      providers,
      exports: [CANOPY_CLIENT, CANOPY_OPTIONS, CanopyGuard],
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
      CanopyGuard,
    ];

    return {
      module: CanopyModule,
      global: options.isGlobal ?? false,
      // Spread rather than assigned: under exactOptionalPropertyTypes an
      // explicit `imports: undefined` is not the same as no `imports` at all.
      ...(options.imports ? { imports: options.imports } : {}),
      providers,
      exports: [CANOPY_CLIENT, CANOPY_OPTIONS, CanopyGuard],
    };
  }
}
