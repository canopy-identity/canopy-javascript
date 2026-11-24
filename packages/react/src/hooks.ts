import type {
  AccessTokenClaims,
  CanopyAuthError,
  CanopyBrowserClient,
  CanopyConnectionError,
  IdTokenClaims,
  Organization,
  OrganizationsState,
  PermissionCheck,
  PermissionState,
  SessionSnapshot,
  SignInOptions,
} from "@canopy-io/browser";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { useCanopyClient, useCanopyContext } from "./context.js";

export interface UseAuthResult {
  status: SessionSnapshot["status"];
  /** True until the provider knows whether someone is signed in. */
  isLoading: boolean;
  isSignedIn: boolean;
  /** The signed-in person's identity id (the ID token's `sub`), or `null`. */
  userId: string | null;
  /** The organization the session is in, or `null` outside one. */
  orgId: string | null;
  /** A current access token for `Authorization: Bearer`; see `useAccessToken`. */
  getAccessToken: () => Promise<string | null>;
  /** Send the browser to Canopy's sign-in. */
  signIn: (options?: SignInOptions) => Promise<void>;
  /** Sign out of the app and of Canopy. */
  signOut: () => Promise<void>;
  /**
   * Canopy's last refusal (`error.needsSignIn` means show a sign-in button),
   * or the connection error when Canopy could not be reached.
   */
  error: CanopyAuthError | CanopyConnectionError | null;
}

/** The session, re-rendering when it changes. */
export function useAuth(): UseAuthResult {
  const { client, connectionError } = useCanopyContext();
  const snapshot = useSession(client);
  const signIn = useCallback(
    (options?: SignInOptions) => client.signIn(options),
    [client],
  );
  const signOut = useCallback(() => client.signOut(), [client]);
  const getAccessToken = useAccessToken();
  const orgId = useAccessTokenClaims()?.org_id ?? null;

  return useMemo(
    () => ({
      status: snapshot.status,
      isLoading: snapshot.status === "loading",
      isSignedIn: snapshot.status === "signed-in",
      userId: snapshot.claims?.sub ?? null,
      orgId,
      getAccessToken,
      signIn,
      signOut,
      error: snapshot.error ?? connectionError,
    }),
    [snapshot, orgId, connectionError, getAccessToken, signIn, signOut],
  );
}

/**
 * The signed-in person's ID token claims, or `null`. `TCustom` names the
 * Environment's custom claims marked for the ID token, each optional:
 * `useUser<{ plan?: string }>()?.plan`.
 */
export function useUser<TCustom extends object = object>():
  (IdTokenClaims & TCustom) | null {
  const snapshot = useSession(useCanopyClient());

  return snapshot.claims as (IdTokenClaims & TCustom) | null;
}

/**
 * A function returning a current access token for `Authorization: Bearer`,
 * refreshed first when it is about to expire; `null` when nobody is signed
 * in. Stable for the provider's lifetime, so it can sit in effect deps.
 */
export function useAccessToken(): () => Promise<string | null> {
  const client = useCanopyClient();

  return useCallback(() => client.getAccessToken(), [client]);
}

/**
 * The current access token's claims, or `null`, re-rendering when the token
 * changes. For display and gating only; the browser cannot check the token's
 * signature, and your API verifies every token it receives.
 */
export function useAccessTokenClaims<TCustom extends object = object>():
  (AccessTokenClaims & TCustom) | null {
  const client = useCanopyClient();
  const subscribe = useSubscribe(client);
  const read = useCallback(
    () => client.getAccessTokenClaims<TCustom>(),
    [client],
  );

  return useSyncExternalStore(subscribe, read, read);
}

export interface UseOrganizationResult {
  /** The organization the session is in, or `null` outside one. */
  orgId: string | null;
  /** The roles the person entered the organization with. */
  orgRoles: string[];
  /** `"all"` for the developer's own staff, who may enter any organization. */
  orgScope: "all" | null;
  /**
   * Move the session into another organization: a sign-in round trip that
   * comes back to the current page.
   */
  switchOrganization: (organizationId: string) => Promise<void>;
}

/** The organization the session is in, read from the access token. */
export function useOrganization(): UseOrganizationResult {
  const client = useCanopyClient();
  const claims = useAccessTokenClaims();
  const switchOrganization = useCallback(
    (organizationId: string) =>
      client.signIn({
        organization: organizationId,
        returnTo: currentPage(),
      }),
    [client],
  );

  return useMemo(
    () => ({
      orgId: claims?.org_id ?? null,
      orgRoles: claims?.org_roles ?? [],
      orgScope: claims?.org_scope === "all" ? "all" : null,
      switchOrganization,
    }),
    [claims, switchOrganization],
  );
}

export interface UseOrganizationListResult {
  /** The organizations the person belongs to, by name; empty until loaded. */
  organizations: Organization[];
  /** True while the session or the list is still on its way. */
  isLoading: boolean;
  /** Why the list could not be read; it is asked again on a later render after a wait. */
  error: CanopyAuthError | CanopyConnectionError | null;
}

/**
 * The organizations the signed-in person belongs to, for an organization
 * switcher (`useOrganization().switchOrganization`). Read once and held until
 * the token changes, the organization changes or the person signs out.
 */
export function useOrganizationList(): UseOrganizationListResult {
  const client = useCanopyClient();
  const session = useSession(client).status;
  const subscribe = useSubscribe(client);
  const read = useCallback(() => client.getOrganizationsState(), [client]);
  const state = useSyncExternalStore(subscribe, read, read);
  const asking = state.status !== "loaded";

  // After every render while nothing is held. Asking is free while a read is
  // on its way, and a failure is held for a while before it is asked again.
  useEffect(() => {
    if (session !== "signed-in" || !asking) {
      return;
    }

    void client.listOrganizations().catch(() => undefined);
  });

  return useMemo(() => organizationsOf(state, session), [state, session]);
}

const NO_ORGANIZATIONS: Organization[] = [];

function organizationsOf(
  state: OrganizationsState,
  session: SessionSnapshot["status"],
): UseOrganizationListResult {
  if (session !== "signed-in") {
    return {
      organizations: NO_ORGANIZATIONS,
      isLoading: session === "loading",
      error: null,
    };
  }

  if (state.status === "loaded") {
    return {
      organizations: state.organizations,
      isLoading: false,
      error: null,
    };
  }

  return {
    organizations: NO_ORGANIZATIONS,
    isLoading: state.status === "loading",
    error: state.status === "error" ? state.error : null,
  };
}

export interface UsePermissionResult {
  /**
   * Whether to show what the permission gates. `false` until an answer
   * arrives, and on an error, so nothing appears that the person cannot use.
   */
  allowed: boolean;
  /** True while the session or the answer is still on its way. */
  isLoading: boolean;
  /** Why the check could not be answered; it is asked again on a later render after a wait. */
  error: CanopyAuthError | CanopyConnectionError | null;
}

/**
 * Whether the signed-in person holds `permission`: at `nodeId` (walking its
 * ancestors), or anywhere in the Environment without one. Answered from the
 * access token where it can say, else by the API, with checks from one render
 * sent in one request and answers held until the token changes.
 *
 * Decides what the page shows; your API still authorizes every request.
 */
export function usePermission(
  permission: string,
  options: { nodeId?: string } = {},
): UsePermissionResult {
  const { nodeId } = options;
  const checks = useMemo<PermissionCheck[]>(
    () => [nodeId === undefined ? { permission } : { permission, nodeId }],
    [permission, nodeId],
  );
  const [result] = usePermissions(checks);

  return result ?? SIGNED_OUT;
}

/**
 * `usePermission` for several checks at once, answered in their order. The
 * checks may be a new array on each render; they are compared by content.
 */
export function usePermissions(
  checks: readonly PermissionCheck[],
): UsePermissionResult[] {
  const client = useCanopyClient();
  const session = useSession(client).status;
  const subscribe = useSubscribe(client);
  // Rebuilt from their content, so a new array with the same checks keeps the
  // same snapshot and asks nothing new.
  const key = JSON.stringify(
    checks.map((check) => [check.permission, check.nodeId ?? null]),
  );
  const stable = useMemo(
    () =>
      (JSON.parse(key) as [string, string | null][]).map(
        ([permission, nodeId]): PermissionCheck =>
          nodeId === null ? { permission } : { permission, nodeId },
      ),
    [key],
  );
  const cache = useRef<PermissionState[]>([]);
  const readStates = useCallback(() => {
    const next = stable.map((check) =>
      client.getPermissionState(check.permission, nodeOf(check)),
    );
    const previous = cache.current;

    if (
      previous.length === next.length &&
      next.every((state, index) => state === previous[index])
    ) {
      return previous;
    }

    cache.current = next;

    return next;
  }, [client, stable]);
  const states = useSyncExternalStore(subscribe, readStates, readStates);
  const asking = states.some(
    (state) => state.status === "loading" || state.status === "error",
  );

  // After every render while something is unanswered. Asking is free for a
  // check already held or on its way: the client sends only the rest,
  // together, and holds a failure for a while before asking it again.
  useEffect(() => {
    if (session !== "signed-in" || !asking) {
      return;
    }

    void client.checkPermissions(stable).catch(() => undefined);
  });

  return useMemo(
    () => states.map((state) => resultOf(state, session)),
    [states, session],
  );
}

const SIGNED_OUT: UsePermissionResult = Object.freeze({
  allowed: false,
  isLoading: false,
  error: null,
});

function resultOf(
  state: PermissionState,
  session: SessionSnapshot["status"],
): UsePermissionResult {
  if (session !== "signed-in") {
    return { allowed: false, isLoading: session === "loading", error: null };
  }

  if (state.status === "error") {
    return { allowed: false, isLoading: false, error: state.error };
  }

  return {
    allowed: state.status === "allowed",
    isLoading: state.status === "loading",
    error: null,
  };
}

function nodeOf(check: PermissionCheck): { nodeId?: string } {
  return check.nodeId === undefined ? {} : { nodeId: check.nodeId };
}

function useSubscribe(
  client: CanopyBrowserClient,
): (listener: () => void) => () => void {
  return useCallback(
    (listener: () => void) => client.subscribe(listener),
    [client],
  );
}

function useSession(client: CanopyBrowserClient): SessionSnapshot {
  const subscribe = useSubscribe(client);
  const read = useCallback(() => client.getSnapshot(), [client]);

  return useSyncExternalStore(subscribe, read, read);
}

export function currentPage(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
