import {
  CanopyClient,
  LocalAuthorizer,
  TokenVerifier,
  type CanopyTokenClaims,
} from "@canopy-io/node";
import { cookies } from "next/headers";
import { cache } from "react";

import {
  CanopyConfigError,
  resolveConfig,
  type CanopyNextConfig,
  type CanopyNextOptions,
} from "./config";
import { decodeClaims } from "./oidc";
import { readSession } from "./session";

/** The ID token's claims: the person, for display. Never authorize from them. */
export interface CanopyUser {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  [claim: string]: unknown;
}

/** The organization the session is in, read from the access token. */
export interface CanopyOrganization {
  orgId: string | null;
  orgRoles: string[];
  /** `"all"` for the developer's own staff, who may enter any organization. */
  orgScope: "all" | null;
}

export interface CanopyAuth {
  isSignedIn: boolean;
  /** The identity's id (`sub`), or `null` when nobody is signed in. */
  userId: string | null;
  user: CanopyUser | null;
  /** The verified access token's claims. */
  claims: CanopyTokenClaims | null;
  organization: CanopyOrganization;
  /** The access token, for `Authorization: Bearer` to your own API. Server only. */
  accessToken: string | null;
  /**
   * Whether the person holds `permission` at `nodeId` (walking its
   * ancestors), or anywhere in the Environment without one.
   *
   * Answered from the token when it can: an Environment-wide check from the
   * `permissions` claim, a check at the session's organization from
   * `org_permissions`, with no request. Any other check is evaluated here
   * from the identity's grants, read with `CANOPY_API_KEY` and held for 60
   * seconds, so repeating a check asks nothing new.
   */
  can: (permission: string, options?: { nodeId?: string }) => Promise<boolean>;
}

const SIGNED_OUT: CanopyAuth = {
  isSignedIn: false,
  userId: null,
  user: null,
  claims: null,
  organization: { orgId: null, orgRoles: [], orgScope: null },
  accessToken: null,
  can: () => Promise.resolve(false),
};

interface Shared {
  verifiers: Map<string, TokenVerifier>;
  authorizers: Map<string, LocalAuthorizer>;
}

// One verifier and one authorizer per process, kept across requests (and
// across Next.js's development reloads), so signing keys and grants are read
// once and reused rather than per request.
const SHARED_KEY = Symbol.for("@canopy-io/nextjs.shared");
const shared: Shared = ((globalThis as Record<symbol, Shared | undefined>)[
  SHARED_KEY
] ??= {
  verifiers: new Map(),
  authorizers: new Map(),
});

/**
 * The signed-in person and their permissions, in a server component, a route
 * handler or a server action. The session is the one `canopyProxy` keeps in
 * the encrypted cookie; the access token is verified here, with Canopy's
 * signing keys cached for the process. Called many times in one render, it
 * verifies once.
 */
export const auth: (options?: CanopyNextOptions) => Promise<CanopyAuth> = cache(
  async (options?: CanopyNextOptions): Promise<CanopyAuth> => {
    const config = resolveConfig(options);
    const session = await readSession(await cookies(), config);

    if (!session) {
      return SIGNED_OUT;
    }

    let claims: CanopyTokenClaims;

    try {
      claims = await verifierFor(config).verify(session.at);
    } catch {
      // Expired (the proxy did not refresh it) or not Canopy's: signed out.
      return SIGNED_OUT;
    }

    const idClaims = session.it ? decodeClaims(session.it) : null;

    return {
      isSignedIn: true,
      userId: claims.sub,
      user: idClaims ? userOf(idClaims) : { sub: claims.sub },
      claims,
      organization: {
        orgId: claims.org_id ?? null,
        orgRoles: claims.org_roles ?? [],
        orgScope: claims.org_scope === "all" ? "all" : null,
      },
      accessToken: session.at,
      can: (permission, checkOptions = {}) =>
        can(config, claims, permission, checkOptions.nodeId),
    };
  },
);

async function can(
  config: CanopyNextConfig,
  claims: CanopyTokenClaims,
  permission: string,
  nodeId: string | undefined,
): Promise<boolean> {
  const fromToken =
    nodeId === undefined
      ? fromList(claims.permissions, claims.permissions_overflow, permission)
      : nodeId === claims.org_id
        ? fromList(
            claims["org_permissions"] as string[] | undefined,
            claims["org_permissions_overflow"] as boolean | undefined,
            permission,
          )
        : undefined;

  if (fromToken !== undefined) {
    return fromToken;
  }

  const decision = await authorizerFor(config).evaluate(
    nodeId === undefined
      ? { identity_id: claims.sub, permission, scope: "app_wide" }
      : { identity_id: claims.sub, permission, node_id: nodeId },
  );

  return decision.allowed;
}

/**
 * The token's answer: held when the key is on the list, not held when the
 * list is complete and the key is off it, and no answer (`undefined`) when
 * there is no list or it was cut short.
 */
function fromList(
  list: string[] | undefined,
  overflow: boolean | undefined,
  permission: string,
): boolean | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }

  if (list.includes(permission)) {
    return true;
  }

  return overflow ? undefined : false;
}

function verifierFor(config: CanopyNextConfig): TokenVerifier {
  const key = `${config.issuer}\u0000${config.clientId}`;
  let verifier = shared.verifiers.get(key);

  if (!verifier) {
    verifier = new TokenVerifier({
      issuer: config.issuer,
      audience: config.clientId,
    });
    shared.verifiers.set(key, verifier);
  }

  return verifier;
}

function authorizerFor(config: CanopyNextConfig): LocalAuthorizer {
  if (!config.apiKey) {
    throw new CanopyConfigError(
      "CANOPY_API_KEY is not set. A permission check the access token cannot answer (one at a node) reads the identity's grants with a secret API key.",
    );
  }

  let authorizer = shared.authorizers.get(config.apiKey);

  if (!authorizer) {
    // The API is Canopy's hosted origin, or CANOPY_BASE_URL when it is set,
    // whatever domain the issuer is on.
    authorizer = new LocalAuthorizer(
      new CanopyClient({ apiKey: config.apiKey }),
    );
    shared.authorizers.set(config.apiKey, authorizer);
  }

  return authorizer;
}

const ID_TOKEN_PROTOCOL_CLAIMS = new Set([
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "nonce",
  "auth_time",
  "at_hash",
  "c_hash",
  "sid",
  "azp",
  "jti",
]);

function userOf(idClaims: Record<string, unknown>): CanopyUser {
  const user: Record<string, unknown> = {};

  for (const [claim, value] of Object.entries(idClaims)) {
    if (!ID_TOKEN_PROTOCOL_CLAIMS.has(claim)) {
      user[claim] = value;
    }
  }

  return user as CanopyUser;
}
