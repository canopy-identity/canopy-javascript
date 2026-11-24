/** What the package reads from the environment, and the defaults beside it. */
export interface CanopyNextConfig {
  /** The Environment's issuer, `https://auth.canopy-io.com/environments/<id>`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Seals the session cookie. At least 32 characters, never committed. */
  secret: string;
  /** The app's own origin, `https://app.example.com`: callbacks return here. */
  appUrl: string;
  /** A secret API key, needed only for permission checks at a node. */
  apiKey: string | undefined;
  scopes: string[];
  routes: CanopyRoutes;
  /** Where sign-out lands once Canopy has ended its own session. */
  afterSignOutPath: string;
  /** How long the session cookie lives without a visit, in seconds. */
  sessionMaxAgeSec: number;
}

/** The paths the proxy answers itself. */
export interface CanopyRoutes {
  signIn: string;
  callback: string;
  signOut: string;
}

/** What `canopyProxy` and `auth()` may be given in code instead of the env. */
export interface CanopyNextOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  secret?: string;
  appUrl?: string;
  apiKey?: string;
  /**
   * Defaults to `openid`, `profile` and `email`. Add `permissions` only when
   * the OAuth client's **Scopes** include it: a client created with the
   * defaults refuses any other scope with `invalid_scope`.
   */
  scopes?: string[];
  routes?: Partial<CanopyRoutes>;
  afterSignOutPath?: string;
  sessionMaxAgeSec?: number;
}

export const DEFAULT_ROUTES: CanopyRoutes = {
  signIn: "/auth/sign-in",
  callback: "/auth/callback",
  signOut: "/auth/sign-out",
};

const DEFAULT_SCOPES = ["openid", "profile", "email"];

/** A confidential client's refresh token slides forward 180 days by default. */
const DEFAULT_SESSION_MAX_AGE_SEC = 180 * 24 * 60 * 60;

const MIN_SECRET_LENGTH = 32;

/** Thrown when the package is missing something it needs to run. */
export class CanopyConfigError extends Error {
  override readonly name = "CanopyConfigError";
}

export function resolveConfig(
  options: CanopyNextOptions = {},
): CanopyNextConfig {
  const env = process.env;
  const issuer = withoutTrailingSlash(
    required(options.issuer ?? env["CANOPY_ISSUER"], "CANOPY_ISSUER"),
  );
  const secret = required(
    options.secret ?? env["CANOPY_SECRET"],
    "CANOPY_SECRET",
  );

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new CanopyConfigError(
      `CANOPY_SECRET must be at least ${MIN_SECRET_LENGTH} characters; generate one with \`openssl rand -base64 32\`.`,
    );
  }

  const apiKey = options.apiKey ?? env["CANOPY_API_KEY"];

  return {
    issuer,
    clientId: required(
      options.clientId ?? env["CANOPY_CLIENT_ID"],
      "CANOPY_CLIENT_ID",
    ),
    clientSecret: required(
      options.clientSecret ?? env["CANOPY_CLIENT_SECRET"],
      "CANOPY_CLIENT_SECRET",
    ),
    secret,
    appUrl: new URL(
      required(options.appUrl ?? env["CANOPY_APP_URL"], "CANOPY_APP_URL"),
    ).origin,
    apiKey: apiKey === "" ? undefined : apiKey,
    scopes: options.scopes ?? DEFAULT_SCOPES,
    routes: { ...DEFAULT_ROUTES, ...options.routes },
    afterSignOutPath: options.afterSignOutPath ?? "/",
    sessionMaxAgeSec: options.sessionMaxAgeSec ?? DEFAULT_SESSION_MAX_AGE_SEC,
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new CanopyConfigError(`${name} is not set.`);
  }

  return value.trim();
}

/**
 * `value` with any trailing slashes removed. A loop rather than a regular
 * expression: an anchored `/+$` backtracks on a long run of slashes, and the
 * paths it trims may come from a request.
 */
export function withoutTrailingSlash(value: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
}
