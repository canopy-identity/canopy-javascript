import { useEffect, type ReactNode } from "react";

import { useCanopyClient } from "./context.js";
import { currentPage, useAuth, usePermission } from "./hooks.js";

/** Renders its children only while someone is signed in. */
export function SignedIn({ children }: { children?: ReactNode }): ReactNode {
  return useAuth().isSignedIn ? children : null;
}

/**
 * Renders its children only once the provider knows nobody is signed in:
 * never while it is still finding out, so a sign-in button does not flash.
 */
export function SignedOut({ children }: { children?: ReactNode }): ReactNode {
  return useAuth().status === "signed-out" ? children : null;
}

export interface RequireAuthProps {
  children?: ReactNode;
  /** Shown while the session loads and while the browser leaves for sign-in. */
  fallback?: ReactNode;
}

/**
 * Renders its children for a signed-in person. Anyone else is sent to Canopy's
 * sign-in, coming back to the page they were on.
 */
export function RequireAuth({
  children,
  fallback = null,
}: RequireAuthProps): ReactNode {
  const client = useCanopyClient();
  const { status } = useAuth();

  useEffect(() => {
    if (status !== "signed-out") {
      return;
    }

    void client.signIn({ returnTo: currentPage() });
  }, [client, status]);

  return status === "signed-in" ? children : fallback;
}

export interface CanProps {
  /** The permission key, for example `deals.read`. */
  permission: string;
  /** The node to ask at, walking its ancestors; without one, anywhere in the Environment. */
  nodeId?: string;
  children?: ReactNode;
  /** Shown while the answer loads, on a denial and on an error. */
  fallback?: ReactNode;
}

/**
 * Renders its children when the signed-in person holds the permission, else
 * the fallback. Decides what the page shows; your API still authorizes every
 * request.
 */
export function Can({
  permission,
  nodeId,
  children,
  fallback = null,
}: CanProps): ReactNode {
  const { allowed } = usePermission(
    permission,
    nodeId === undefined ? {} : { nodeId },
  );

  return allowed ? children : fallback;
}
