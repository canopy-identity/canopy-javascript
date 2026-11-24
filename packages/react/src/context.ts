import type {
  CanopyBrowserClient,
  CanopyConnectionError,
} from "@canopy-io/browser";
import { createContext, useContext } from "react";

export interface CanopyContextValue {
  client: CanopyBrowserClient;
  /**
   * `start()` could not reach Canopy at all. The session snapshot only carries
   * Canopy's own refusals, so the provider holds this one.
   */
  connectionError: CanopyConnectionError | null;
}

export const CanopyContext = createContext<CanopyContextValue | null>(null);

export function useCanopyContext(): CanopyContextValue {
  const value = useContext(CanopyContext);

  if (!value) {
    throw new Error(
      "Canopy hooks and components must be rendered inside <CanopyProvider>.",
    );
  }

  return value;
}

/** The browser client the nearest `<CanopyProvider>` holds. */
export function useCanopyClient(): CanopyBrowserClient {
  return useCanopyContext().client;
}
