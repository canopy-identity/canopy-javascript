import type { CanopyNextConfig } from "./config";
import type { StoredSession } from "./session";
import { toBase64Url } from "./seal";

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/**
 * Canopy refused or could not answer a sign-in, a refresh or a sign-out.
 * `code` is Canopy's OAuth error (`invalid_grant`), or `connection_failed`
 * when no answer could be read.
 */
export class CanopySessionError extends Error {
  override readonly name = "CanopySessionError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const discoveries = new Map<string, Promise<Discovery>>();

/** The Environment's OAuth endpoints, read once per issuer for the process. */
export function discover(config: CanopyNextConfig): Promise<Discovery> {
  let discovery = discoveries.get(config.issuer);

  if (!discovery) {
    discovery = (async () => {
      const response = await request(
        `${config.issuer}/.well-known/openid-configuration`,
        {
          headers: { accept: "application/json" },
        },
      );

      if (!response.ok) {
        throw new CanopySessionError(
          "discovery_failed",
          `Canopy's discovery document answered ${response.status}.`,
        );
      }

      return (await response.json()) as Discovery;
    })();
    // A failed read is not kept, so the next request asks again.
    discovery.catch(() => discoveries.delete(config.issuer));
    discoveries.set(config.issuer, discovery);
  }

  return discovery;
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return toBase64Url(new Uint8Array(digest));
}

export function callbackUrl(config: CanopyNextConfig): string {
  return `${config.appUrl}${config.routes.callback}`;
}

/** Trade the sign-in's code for tokens, as a confidential client. */
export async function exchangeCode(
  config: CanopyNextConfig,
  code: string,
  verifier: string,
): Promise<StoredSession> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(config),
    code_verifier: verifier,
  });
}

const refreshes = new Map<string, Promise<StoredSession>>();

/**
 * A new access token for the session. Requests in this process that refresh
 * the same token share one call; requests on other instances may each send
 * their own, and Canopy answers those with the same refresh token.
 */
export function refreshSession(
  config: CanopyNextConfig,
  session: StoredSession,
): Promise<StoredSession> {
  const refreshToken = session.rt;

  if (!refreshToken) {
    return Promise.reject(
      new CanopySessionError(
        "invalid_grant",
        "The session has no refresh token.",
      ),
    );
  }

  let pending = refreshes.get(refreshToken);

  if (!pending) {
    pending = tokenRequest(config, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).then((next) => ({
      ...next,
      // A refresh need not return a new ID token; sign-out still needs one.
      ...(next.it === undefined && session.it !== undefined
        ? { it: session.it }
        : {}),
      ...(next.rt === undefined ? { rt: refreshToken } : {}),
    }));
    refreshes.set(refreshToken, pending);
    pending.then(
      () => refreshes.delete(refreshToken),
      () => refreshes.delete(refreshToken),
    );
  }

  return pending;
}

/** End the session at Canopy's token endpoint. A failure is not an error. */
export async function revoke(
  config: CanopyNextConfig,
  refreshToken: string,
): Promise<void> {
  try {
    const { revocation_endpoint } = await discover(config);

    if (!revocation_endpoint) {
      return;
    }

    await request(revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
  } catch {
    // Sign-out goes on: the cookie is cleared and Canopy's session is ended
    // through the end-session endpoint either way.
  }
}

/** The claims of a JWT, unverified: for a token Canopy just handed over. */
export function decodeClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];

  if (!payload) {
    return null;
  }

  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));

    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

async function tokenRequest(
  config: CanopyNextConfig,
  params: Record<string, string>,
): Promise<StoredSession> {
  const { token_endpoint } = await discover(config);
  const response = await request(token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      ...params,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  const body = (await response.json().catch(() => null)) as
    (TokenResponse & { error?: string; error_description?: string }) | null;

  if (!response.ok || !body?.access_token) {
    throw new CanopySessionError(
      body?.error ?? "token_request_failed",
      body?.error_description ??
        `Canopy's token endpoint answered ${response.status}.`,
    );
  }

  return {
    at: body.access_token,
    ...(body.refresh_token ? { rt: body.refresh_token } : {}),
    ...(body.id_token ? { it: body.id_token } : {}),
    exp: expiryOf(body),
  };
}

function expiryOf(body: TokenResponse): number {
  const exp = decodeClaims(body.access_token)?.["exp"];

  if (typeof exp === "number") {
    return exp;
  }

  return Math.floor(Date.now() / 1000) + (body.expires_in ?? 0);
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store" });
  } catch (caught) {
    throw new CanopySessionError(
      "connection_failed",
      `Canopy could not be reached: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
}
