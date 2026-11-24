import type { CanopyAuth } from "./auth";
import type { CanopyClientSession } from "./client";

/**
 * The part of `auth()` a client component may hold: who is signed in and the
 * organization. Tokens and claims stay on the server, so nothing passed to
 * the browser can be replayed against Canopy or your API.
 */
export function clientSession(auth: CanopyAuth): CanopyClientSession {
  const { user } = auth;

  return {
    isSignedIn: auth.isSignedIn,
    userId: auth.userId,
    user: user
      ? {
          sub: user.sub,
          ...(typeof user.name === "string" ? { name: user.name } : {}),
          ...(typeof user.email === "string" ? { email: user.email } : {}),
          ...(typeof user.picture === "string"
            ? { picture: user.picture }
            : {}),
        }
      : null,
    organization: { ...auth.organization },
  };
}
