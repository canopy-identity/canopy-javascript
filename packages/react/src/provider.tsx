import {
  CanopyBrowserClient,
  CanopyConnectionError,
  type CanopyBrowserClientOptions,
} from "@canopy-io/browser";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CanopyContext, type CanopyContextValue } from "./context.js";

interface ProviderBehaviour {
  children?: ReactNode;
  /**
   * Called once a sign-in finishes with the page it started on, so the app's
   * router can go back there. Without it the provider replaces the address
   * with `returnTo` through `history`, which a router does not see.
   */
  onRedirectCallback?: (returnTo: string) => void;
  /**
   * `false` finishes a sign-in coming back from Canopy but never sends a
   * visitor to Canopy to resume one: for public pages where an anonymous
   * visitor should stay put. Default `true`.
   */
  resume?: boolean;
}

/**
 * Either the browser client's options, from which the provider creates one
 * client for its lifetime, or a client you created, for sharing it with code
 * outside React (a fetch wrapper, a router loader).
 */
export type CanopyProviderProps = ProviderBehaviour &
  (
    | (CanopyBrowserClientOptions & { client?: never })
    | { client: CanopyBrowserClient }
  );

/**
 * Holds one Canopy browser client and starts it once: it finishes a sign-in
 * coming back from Canopy, or resumes the session silently. Hooks and
 * components beneath it read that client.
 *
 * Renders the same on the server and does nothing there: the client is
 * created without touching a browser global, and `start()` runs in an effect.
 */
export function CanopyProvider(props: CanopyProviderProps): ReactNode {
  const { children, onRedirectCallback, resume } = props;
  const [client] = useState(() =>
    props.client ? props.client : new CanopyBrowserClient(optionsOf(props)),
  );
  const [connectionError, setConnectionError] =
    useState<CanopyConnectionError | null>(null);
  const [, setFailure] = useState<null>(null);
  // Read when start() settles, so a callback recreated on every render is
  // never a reason to start again.
  const redirectCallback = useRef(onRedirectCallback);

  useEffect(() => {
    redirectCallback.current = onRedirectCallback;
  });

  useEffect(() => {
    // StrictMode runs this twice. The client shares one start() between the
    // calls, and only the effect still mounted acts on the result, so the
    // app is sent back to its page once.
    let current = true;

    client.start(resume === false ? { resume: false } : {}).then(
      (result) => {
        if (!current) {
          return;
        }

        setConnectionError(null);

        if (
          (result.status === "signed-in" || result.status === "error") &&
          result.returnTo !== undefined
        ) {
          returnTo(result.returnTo, redirectCallback.current);
        }
      },
      (caught: unknown) => {
        if (!current) {
          return;
        }

        if (caught instanceof CanopyConnectionError) {
          setConnectionError(caught);

          return;
        }

        // Anything else is a bug, raised to the nearest error boundary.
        setFailure(() => {
          throw caught;
        });
      },
    );

    return () => {
      current = false;
    };
  }, [client, resume]);

  const value = useMemo<CanopyContextValue>(
    () => ({ client, connectionError }),
    [client, connectionError],
  );

  return (
    <CanopyContext.Provider value={value}>{children}</CanopyContext.Provider>
  );
}

function optionsOf(props: CanopyProviderProps): CanopyBrowserClientOptions {
  // Everything but the provider's own props is the client's options.
  const options: Record<string, unknown> = { ...props };

  for (const own of ["children", "onRedirectCallback", "resume", "client"]) {
    delete options[own];
  }

  return options as unknown as CanopyBrowserClientOptions;
}

function returnTo(
  page: string,
  onRedirectCallback: ((returnTo: string) => void) | undefined,
): void {
  if (onRedirectCallback) {
    onRedirectCallback(page);

    return;
  }

  window.history.replaceState(window.history.state, "", page);
}
