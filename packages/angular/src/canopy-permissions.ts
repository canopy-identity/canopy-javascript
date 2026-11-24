import { computed, inject, Injectable, type Signal } from "@angular/core";
import type {
  CanopyAuthError,
  CanopyConnectionError,
  PermissionState,
} from "@canopy-io/browser";

import { CanopyAuth } from "./canopy-auth";
import { CANOPY_CLIENT } from "./provide-canopy";

/** What a permission signal holds. */
export interface CanopyPermission {
  /**
   * Whether to show what the permission gates. `false` until an answer
   * arrives, and on an error, so nothing appears that the person cannot use.
   */
  allowed: boolean;
  /** True while the session or the answer is still on its way. */
  isLoading: boolean;
  /** Why the check could not be answered; it is asked again after a wait. */
  error: CanopyAuthError | CanopyConnectionError | null;
}

/**
 * The signed-in person's permissions as signals, read from the browser
 * client. The client answers from the access token where it can, sends the
 * rest of the checks made together in one request, and holds each answer
 * until the token changes, so reading a signal again asks nothing new.
 *
 * These decide what a page shows; your API still authorizes every request.
 */
@Injectable({ providedIn: "root" })
export class CanopyPermissions {
  readonly #client = inject(CANOPY_CLIENT);
  readonly #auth = inject(CanopyAuth);
  readonly #signals = new Map<string, Signal<CanopyPermission>>();

  /**
   * Whether the person holds `permission` at `nodeId` (walking its
   * ancestors), or anywhere in the Environment without one. The same check
   * returns the same signal.
   */
  can(
    permission: string,
    options: { nodeId?: string } = {},
  ): Signal<CanopyPermission> {
    const { nodeId } = options;
    const key = `${nodeId ?? ""}\u0000${permission}`;
    let held = this.#signals.get(key);

    if (!held) {
      held = computed(() => {
        this.#auth.version();

        const session = this.#auth.status();

        if (session !== "signed-in") {
          return {
            allowed: false,
            isLoading: session === "loading",
            error: null,
          };
        }

        const check = nodeId === undefined ? {} : { nodeId };
        const state = this.#client.getPermissionState(permission, check);

        if (state.status === "loading" || state.status === "error") {
          // Asking is free for a check already held or on its way; the
          // client sends the rest of one tick's checks in one request.
          queueMicrotask(() => {
            void this.#client
              .checkPermission(permission, check)
              .catch(() => undefined);
          });
        }

        return resultOf(state);
      });
      this.#signals.set(key, held);
    }

    return held;
  }
}

function resultOf(state: PermissionState): CanopyPermission {
  if (state.status === "error") {
    return { allowed: false, isLoading: false, error: state.error };
  }

  return {
    allowed: state.status === "allowed",
    isLoading: state.status === "loading",
    error: null,
  };
}
