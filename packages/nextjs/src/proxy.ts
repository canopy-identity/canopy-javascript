import { NextResponse, type NextRequest } from "next/server";

import {
  resolveConfig,
  withoutTrailingSlash,
  type CanopyNextConfig,
  type CanopyNextOptions,
} from "./config";
import {
  callbackUrl,
  CanopySessionError,
  codeChallenge,
  decodeClaims,
  discover,
  exchangeCode,
  randomToken,
  refreshSession,
  revoke,
} from "./oidc";
import {
  cookieOptions,
  readSession,
  readTransaction,
  sessionWrites,
  TRANSACTION_COOKIE,
  transactionWrite,
  type CookieWrite,
  type StoredSession,
} from "./session";

export interface CanopyProxyOptions extends CanopyNextOptions {
  /**
   * The paths that need a signed-in person: a signed-out visitor is sent to
   * Canopy's sign-in and back. A string protects that path and everything
   * under it (`"/reports"` covers `/reports/2026`); a function decides.
   */
  protect?: string[] | ((pathname: string) => boolean);
}

/** Refresh this long before the access token expires, so a page never meets an expired one. */
const REFRESH_LEEWAY_SEC = 60;

/**
 * The Next.js proxy (`proxy.ts`, or `middleware.ts` on Next.js 15.5 with
 * `runtime: "nodejs"`). It answers the sign-in, callback and sign-out routes,
 * refreshes the session shortly before its access token expires, and turns a
 * signed-out visitor away from a protected path before anything renders.
 *
 * A request whose access token is still valid sends nothing to Canopy: the
 * cookie is opened and its expiry read, nothing more.
 */
export function canopyProxy(
  options: CanopyProxyOptions = {},
): (request: NextRequest) => Promise<NextResponse> {
  let config: CanopyNextConfig | undefined;

  return async (request) => {
    config ??= resolveConfig(options);

    const { pathname } = request.nextUrl;

    if (pathname === config.routes.signIn) {
      return signIn(request, config);
    }

    if (pathname === config.routes.callback) {
      return callback(request, config);
    }

    if (pathname === config.routes.signOut) {
      return signOut(request, config);
    }

    return pass(request, config, isProtected(pathname, options.protect));
  };
}

async function signIn(
  request: NextRequest,
  config: CanopyNextConfig,
): Promise<NextResponse> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const transaction = {
    state: randomToken(),
    verifier: randomToken(),
    nonce: randomToken(),
    returnTo,
  };
  const { authorization_endpoint } = await discover(config);
  const authorize = new URL(authorization_endpoint);

  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    scope: config.scopes.join(" "),
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: await codeChallenge(transaction.verifier),
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorize);

  apply(response, [await transactionWrite(transaction, config)], config);

  return response;
}

async function callback(
  request: NextRequest,
  config: CanopyNextConfig,
): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const transaction = await readTransaction(
    request.cookies.get(TRANSACTION_COOKIE)?.value,
    config,
  );
  const cleared: CookieWrite = {
    name: TRANSACTION_COOKIE,
    value: "",
    maxAge: 0,
  };

  if (!transaction || params.get("state") !== transaction.state) {
    const response = new NextResponse(
      "This sign-in has expired. Start it again.",
      {
        status: 400,
      },
    );

    apply(response, [cleared], config);

    return response;
  }

  const back = new URL(transaction.returnTo, config.appUrl);
  const code = params.get("code");

  // Canopy refused the sign-in (the person cancelled, or a silent one found
  // no session): back to the page it started on, still signed out.
  if (!code) {
    const response = NextResponse.redirect(back);

    apply(response, [cleared], config);

    return response;
  }

  const session = await exchangeCode(config, code, transaction.verifier);
  const idClaims = session.it ? decodeClaims(session.it) : null;

  if (session.it && idClaims?.["nonce"] !== transaction.nonce) {
    throw new CanopySessionError(
      "invalid_nonce",
      "The ID token's nonce does not match this sign-in.",
    );
  }

  const response = NextResponse.redirect(back);

  apply(
    response,
    [cleared, ...(await sessionWrites(session, request.cookies, config))],
    config,
  );

  return response;
}

async function signOut(
  request: NextRequest,
  config: CanopyNextConfig,
): Promise<NextResponse> {
  const session = await readSession(request.cookies, config);
  const landing = `${config.appUrl}${config.afterSignOutPath}`;

  let destination = landing;

  if (session?.rt) {
    await revoke(config, session.rt);
  }

  const { end_session_endpoint } = await discover(config).catch(() => ({
    end_session_endpoint: undefined,
  }));

  // Canopy's own session ends too, or the next sign-in would return the
  // person without a password.
  if (end_session_endpoint) {
    const end = new URL(end_session_endpoint);

    end.search = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: landing,
      ...(session?.it ? { id_token_hint: session.it } : {}),
    }).toString();
    destination = end.toString();
  }

  const response = NextResponse.redirect(destination);

  apply(response, await sessionWrites(null, request.cookies, config), config);

  return response;
}

async function pass(
  request: NextRequest,
  config: CanopyNextConfig,
  protectedPath: boolean,
): Promise<NextResponse> {
  let session = await readSession(request.cookies, config);
  let writes: CookieWrite[] = [];

  if (session && session.exp - nowSec() <= REFRESH_LEEWAY_SEC) {
    const refreshed = await tryRefresh(config, session);

    session = refreshed;
    writes = await sessionWrites(refreshed, request.cookies, config);
  }

  if (!session && protectedPath) {
    const signInUrl = new URL(config.routes.signIn, config.appUrl);

    signInUrl.searchParams.set(
      "returnTo",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );

    const response = NextResponse.redirect(signInUrl);

    apply(response, writes, config);

    return response;
  }

  if (writes.length === 0) {
    return NextResponse.next();
  }

  // The page rendering this request reads the new session too, not only
  // the browser's next request.
  for (const write of writes) {
    if (write.maxAge === 0) {
      request.cookies.delete(write.name);
    } else {
      request.cookies.set(write.name, write.value);
    }
  }

  const response = NextResponse.next({ request: { headers: request.headers } });

  apply(response, writes, config);

  return response;
}

/** The refreshed session, or null when Canopy no longer honours it. */
async function tryRefresh(
  config: CanopyNextConfig,
  session: StoredSession,
): Promise<StoredSession | null> {
  try {
    return await refreshSession(config, session);
  } catch (caught) {
    if (
      caught instanceof CanopySessionError &&
      caught.code === "connection_failed"
    ) {
      // Canopy could not be reached: keep the session while its token is
      // still valid, and try again on the next request.
      return session.exp > nowSec() ? session : null;
    }

    return null;
  }
}

function apply(
  response: NextResponse,
  writes: CookieWrite[],
  config: CanopyNextConfig,
): void {
  for (const write of writes) {
    response.cookies.set(
      write.name,
      write.value,
      cookieOptions(config, write.maxAge),
    );
  }
}

function isProtected(
  pathname: string,
  protect: CanopyProxyOptions["protect"],
): boolean {
  if (!protect) {
    return false;
  }

  if (typeof protect === "function") {
    return protect(pathname);
  }

  return protect.some((prefix) => {
    const base = withoutTrailingSlash(prefix);

    return base === "" || pathname === base || pathname.startsWith(`${base}/`);
  });
}

/** Only a path on this site: never another origin, and never `//host`. */
function safeReturnTo(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  ) {
    return "/";
  }

  return value;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
