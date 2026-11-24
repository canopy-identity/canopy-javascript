import { Location } from "@angular/common";
import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
  type Signal,
} from "@angular/core";
import type {
  AccessTokenClaims,
  CanopyAuthError,
  CanopyConnectionError,
  IdTokenClaims,
  Organization,
  SessionSnapshot,
  SignInOptions,
} from "@canopy-io/browser";

import { CANOPY_CLIENT, CANOPY_STATE } from "./provide-canopy";

/** The organization the session is in, read from the access token. */
export interface CanopyOrganization {
  /** The organization's id, or `null` outside one. */
  orgId: string | null;
  /** The roles the person entered the organization with. */
  orgRoles: string[];
  /** `"all"` for the developer's own staff, who may enter any organization. */
  orgScope: "all" | null;
}

/** The organizations the person belongs to, for a switcher. */
export interface CanopyOrganizationList {
  /** By name; empty until loaded. */
  organizations: Organization[];
  isLoading: boolean;
  /** Why the list could not be read; it is asked again after a wait. */
  error: CanopyAuthError | CanopyConnectionError | null;
}

const NO_ORGANIZATIONS: Organization[] = [];

/**
 * The session as signals, read from the browser client `provideCanopy`
 * holds. Every signal changes when the client says the session changed:
 * sign-in, refresh, organization switch, sign-out.
 */
@Injectable({ providedIn: "root" })
export class CanopyAuth {
  readonly #client = inject(CANOPY_CLIENT);
  readonly #state = inject(CANOPY_STATE);
  readonly #location = inject(Location);
  /** Bumped whenever the client reports a change; computed signals read it. */
  readonly #version = signal(0);
  readonly #snapshot = signal<SessionSnapshot>(this.#client.getSnapshot());

  /** `loading` until the session is known, then `signed-in` or `signed-out`. */
  readonly status: Signal<SessionSnapshot["status"]> = computed(
    () => this.#snapshot().status,
  );
  readonly isLoading = computed(() => this.status() === "loading");
  readonly isSignedIn = computed(() => this.status() === "signed-in");
  /** The ID token's claims, or `null`. Show them; never authorize from them. */
  readonly user: Signal<IdTokenClaims | null> = computed(
    () => this.#snapshot().claims,
  );
  /** The access token's claims, or `null`: for display and gating only. */
  readonly accessTokenClaims: Signal<AccessTokenClaims | null> = computed(
    () => {
      this.#version();

      return this.#client.getAccessTokenClaims();
    },
  );
  readonly organization: Signal<CanopyOrganization> = computed(() => {
    const claims = this.accessTokenClaims();

    return {
      orgId: claims?.org_id ?? null,
      orgRoles: claims?.org_roles ?? [],
      orgScope: claims?.["org_scope"] === "all" ? "all" : null,
    };
  });
  /**
   * Canopy's last refusal (`error.needsSignIn` means show a sign-in button),
   * or the connection error when Canopy could not be reached at all.
   */
  readonly error: Signal<CanopyAuthError | CanopyConnectionError | null> =
    computed(() => this.#snapshot().error ?? this.#state.connectionError());

  #organizationList: Signal<CanopyOrganizationList> | undefined;

  constructor() {
    const stop = this.#client.subscribe(() => {
      this.#snapshot.set(this.#client.getSnapshot());
      this.#version.update((v) => v + 1);
    });

    inject(DestroyRef).onDestroy(stop);
  }

  /** @internal Read by the permission signals so they follow every change. */
  version(): number {
    return this.#version();
  }

  /** Send the browser to Canopy's sign-in. */
  signIn(options?: SignInOptions): Promise<void> {
    return this.#client.signIn(options);
  }

  /** Sign out of the app and of Canopy. */
  signOut(): Promise<void> {
    return this.#client.signOut();
  }

  /**
   * Move the session into another organization: a sign-in round trip that
   * comes back to the current page.
   */
  switchOrganization(organizationId: string): Promise<void> {
    return this.#client.signIn({
      organization: organizationId,
      returnTo: this.#location.path(true) || "/",
    });
  }

  /**
   * A current access token for `Authorization: Bearer`, refreshed first when
   * it is about to expire; `null` when nobody is signed in.
   * `canopyAuthInterceptor` attaches it for you.
   */
  getAccessToken(): Promise<string | null> {
    return this.#client.getAccessToken();
  }

  /**
   * The organizations the person belongs to, by name, for an organization
   * switcher. Read once and held by the browser client until the token
   * changes; reading the signal asks nothing new.
   */
  organizationList(): Signal<CanopyOrganizationList> {
    this.#organizationList ??= computed(() => {
      this.#version();

      const session = this.status();

      if (session !== "signed-in") {
        return {
          organizations: NO_ORGANIZATIONS,
          isLoading: session === "loading",
          error: null,
        };
      }

      const state = this.#client.getOrganizationsState();

      if (state.status === "loaded") {
        return {
          organizations: state.organizations,
          isLoading: false,
          error: null,
        };
      }

      // Asking is free while a read is on its way or a failure is held; the
      // client sends a request only when nothing is.
      queueMicrotask(() => {
        void this.#client.listOrganizations().catch(() => undefined);
      });

      return {
        organizations: NO_ORGANIZATIONS,
        isLoading: state.status === "loading",
        error: state.status === "error" ? state.error : null,
      };
    });

    return this.#organizationList;
  }
}
