import { isPlatformBrowser, Location } from "@angular/common";
import {
  inject,
  InjectionToken,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideAppInitializer,
  signal,
  type EnvironmentProviders,
  type WritableSignal,
} from "@angular/core";
import {
  CanopyBrowserClient,
  CanopyConnectionError,
  type CanopyBrowserClientOptions,
} from "@canopy-io/browser";

/** What `provideCanopy` takes beyond the browser client's own options. */
export interface CanopyProviderOptions {
  /**
   * `false` finishes a sign-in coming back from Canopy but never sends a
   * visitor to Canopy to resume one: for public apps where an anonymous
   * visitor should stay put. Default `true`.
   */
  resume?: boolean;
  /**
   * The origins `canopyAuthInterceptor` attaches the access token to, such as
   * `https://api.example.com`. Every other request goes out without it.
   */
  apiOrigins?: readonly string[];
}

/**
 * Either the browser client's options, from which one client is created for
 * the app, or a client you created, for sharing it with code outside Angular.
 */
export type ProvideCanopyOptions = CanopyProviderOptions &
  (
    | (CanopyBrowserClientOptions & { client?: never })
    | { client: CanopyBrowserClient }
  );

/** The browser client `provideCanopy` holds; inject it to reach the rest. */
export const CANOPY_CLIENT = new InjectionToken<CanopyBrowserClient>(
  "CANOPY_CLIENT",
);

/** @internal What the package's own pieces share. */
export interface CanopyState {
  apiOrigins: readonly string[];
  /** `start()` could not reach Canopy; Canopy's own refusals are on the snapshot. */
  connectionError: WritableSignal<CanopyConnectionError | null>;
}

/** @internal */
export const CANOPY_STATE = new InjectionToken<CanopyState>("CANOPY_STATE");

/**
 * Holds one Canopy browser client and starts it before the first navigation:
 * it finishes a sign-in coming back from Canopy, or resumes the session
 * silently, and puts the page the sign-in started on in the address bar, so
 * the router's first navigation lands there.
 *
 * On the server it does nothing: the client is created without touching a
 * browser global, and it starts only in a browser.
 */
export function provideCanopy(
  options: ProvideCanopyOptions,
): EnvironmentProviders {
  const { resume, apiOrigins } = options;

  return makeEnvironmentProviders([
    {
      provide: CANOPY_CLIENT,
      useFactory: () =>
        options.client ?? new CanopyBrowserClient(clientOptionsOf(options)),
    },
    {
      provide: CANOPY_STATE,
      useFactory: (): CanopyState => ({
        apiOrigins: (apiOrigins ?? []).map((origin) => new URL(origin).origin),
        connectionError: signal(null),
      }),
    },
    provideAppInitializer(async () => {
      if (!isPlatformBrowser(inject(PLATFORM_ID))) {
        return;
      }

      const client = inject(CANOPY_CLIENT);
      const state = inject(CANOPY_STATE);
      const location = inject(Location);

      try {
        const result = await client.start(
          resume === false ? { resume: false } : {},
        );

        if (
          (result.status === "signed-in" || result.status === "error") &&
          result.returnTo !== undefined
        ) {
          location.replaceState(result.returnTo);
        }
      } catch (caught) {
        if (caught instanceof CanopyConnectionError) {
          state.connectionError.set(caught);

          return;
        }

        throw caught;
      }
    }),
  ]);
}

function clientOptionsOf(
  options: ProvideCanopyOptions,
): CanopyBrowserClientOptions {
  // Everything but this package's own options is the client's.
  const rest: Record<string, unknown> = { ...options };

  for (const own of ["resume", "apiOrigins", "client"]) {
    delete rest[own];
  }

  return rest as unknown as CanopyBrowserClientOptions;
}
