import { createContext, useContext, type ReactNode } from "react";

/**
 * What a client component may know about the session: who is signed in and
 * the organization, handed down from the server. It holds no token, and
 * nothing here sends a request.
 */
export interface CanopyClientSession {
  isSignedIn: boolean;
  userId: string | null;
  user: {
    sub: string;
    name?: string;
    email?: string;
    picture?: string;
  } | null;
  organization: {
    orgId: string | null;
    orgRoles: string[];
    orgScope: "all" | null;
  };
}

const SIGNED_OUT: CanopyClientSession = {
  isSignedIn: false,
  userId: null,
  user: null,
  organization: { orgId: null, orgRoles: [], orgScope: null },
};

const SessionContext = createContext<CanopyClientSession>(SIGNED_OUT);

/**
 * Puts the session `clientSession()` read on the server where client
 * components can reach it. Render it in the root layout:
 * `<CanopySessionProvider session={clientSession(await auth())}>`.
 */
export function CanopySessionProvider({
  session,
  children,
}: {
  session: CanopyClientSession;
  children?: ReactNode;
}): ReactNode {
  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

/** The session, in a client component. */
export function useCanopySession(): CanopyClientSession {
  return useContext(SessionContext);
}
