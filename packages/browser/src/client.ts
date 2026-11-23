import { CanopyAuthError, CanopyConnectionError } from "./errors.js";
import {
  checkIdToken,
  decodeJwtPayload,
  type IdTokenClaims,
} from "./id-token.js";
import {
  type PermissionCheck,
  PermissionChecks,
  type PermissionClaims,
  type PermissionState,
} from "./permissions.js";
import { createPkcePair, randomString } from "./pkce.js";

/** The storage this package keeps a sign-in's PKCE verifier in across the redirect. */
export type PendingStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export interface CanopyBrowserClientOptions {
  /**
   * The Environment's issuer: `https://canopy-io.com/environments/<id>`, or
   * your custom auth domain. Endpoints are read from its discovery document.
   */
  issuer: string;
  /** The public OAuth client's `client_id`. It has no secret. */
  clientId: string;
  /** Registered on the client, exactly. Where Canopy sends the browser back. */
  redirectUri: string;
  /** Default `["openid", "profile", "email"]`; each must be registered on the client. */
  scopes?: readonly string[];
  /** Registered on the client as a post-logout redirect URL. Where `signOut()` lands. */
  postLogoutRedirectUri?: string;
  /** Refresh the access token this many seconds before it expires. Default 60. */
  refreshLeewaySeconds?: number;
  /** Called once when the session ends on its own: its lifetime ran out, or it was revoked. */
  onSessionEnd?: (error: CanopyAuthError) => void;
  /**
   * Defaults to `sessionStorage`, read on first use, so the client can be
   * constructed where there is none (server rendering). Holds only the
   * verifier for the round trip, never a token.
   */
  storage?: PendingStorage;
  /** Defaults to `location.assign`. */
  navigate?: (url: string) => void;
  /** Defaults to removing the response parameters with `history.replaceState`. */
  replaceUrl?: (url: string) => void;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

export interface SignInOptions {
  /** `login` shows the form whatever the browser holds; `none` shows no page. */
  prompt?: "login" | "none";
  /** Sign straight into this organization (its id). */
  organization?: string;
  /** An email address to put in the sign-in form. */
  loginHint?: string;
  /**
   * The languages to show the hosted pages in, most preferred first, as
   * language tags separated by spaces (`"es fr"`): usually your app's own
   * language. Sent as `ui_locales`. The first one the pages are written in
   * wins; with none, the person's stored language, then the browser's.
   */
  uiLocales?: string;
  /** Your app's path or URL to go back to after sign-in; returned by `handleRedirect()`. */
  returnTo?: string;
}

export interface StartOptions {
  /** The page's URL. Defaults to `location.href`. */
  url?: string;
  /**
   * `false` finishes a sign-in Canopy has just sent the browser back from,
   * but never sends the browser to Canopy to resume one: for a public page
   * that should not bounce an anonymous visitor. Default `true`.
   */
  resume?: boolean;
}

/**
 * The session as a page renders it. The same object until something changes:
 * a sign-in, a refresh, an organization switch or the end of the session.
 * Shaped for `useSyncExternalStore` and for Angular signals.
 */
export interface SessionSnapshot {
  /**
   * `loading` until `start()` settles, and while it is sending the browser to
   * Canopy; then `signed-in` or `signed-out`.
   */
  status: "loading" | "signed-in" | "signed-out";
  /** The ID token's claims while signed in, else `null`. */
  claims: IdTokenClaims | null;
  /** Why the last sign-in failed, when it did. `error.needsSignIn` means show your sign-in button. */
  error: CanopyAuthError | null;
}

/**
 * The claims of the current access token, read for display and gating only:
 * the browser cannot check the token's signature, and your API must verify
 * every token it receives (`@canopy-io/node`).
 */
export interface AccessTokenClaims extends PermissionClaims {
  sub: string;
  iss: string;
  exp: number;
  /** With the `permissions` scope. */
  permissions?: string[];
  permissions_overflow?: boolean;
  /** When the session is inside an organization. */
  org_id?: string;
  org_roles?: string[];
  /** With the `permissions` scope, inside an organization: what the person holds there. */
  org_permissions?: string[];
  org_permissions_overflow?: boolean;
  [claim: string]: unknown;
}

/** What `handleRedirect()` and `start()` found. */
export type SignInResult =
  /** Signed in: tokens are in memory. */
  | { status: "signed-in"; returnTo: string | undefined }
  /**
   * Canopy refused. `error.needsSignIn` means show your sign-in button: a
   * silent attempt found no session, or the sign-in needs the person.
   */
  | { status: "error"; error: CanopyAuthError; returnTo: string | undefined }
  /** The URL carried no answer from Canopy, and nobody is signed in. */
  | { status: "signed-out" }
  /** `start()` sent the browser to Canopy to resume a session silently. */
  | { status: "redirecting" };

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface Pending {
  verifier: string;
  nonce: string;
  returnTo?: string;
}

interface Session {
  accessToken: string;
  accessClaims: AccessTokenClaims | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshToken: string | undefined;
  idToken: string;
  claims: IdTokenClaims;
}

const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;
const RESPONSE_PARAMS = [
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "iss",
];

/**
 * Create a client for a single-page app signing in through Canopy's hosted
 * login as a public OAuth client.
 *
 * Tokens live in this object's memory and nowhere else, so a script injected
 * into the page cannot read them from storage. A reload loses them; `start()`
 * gets them back by sending the browser to Canopy with `prompt=none`, which
 * returns at once while the person's Canopy session lasts.
 */
export function createCanopyBrowserClient(
  options: CanopyBrowserClientOptions,
): CanopyBrowserClient {
  return new CanopyBrowserClient(options);
}

export class CanopyBrowserClient {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #scopes: readonly string[];
  readonly #postLogoutRedirectUri: string | undefined;
  readonly #leewayMs: number;
  readonly #onSessionEnd: ((error: CanopyAuthError) => void) | undefined;
  readonly #storageOption: PendingStorage | undefined;
  readonly #navigate: (url: string) => void;
  readonly #replaceUrl: (url: string) => void;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  readonly #listeners = new Set<() => void>();
  readonly #permissions: PermissionChecks;

  #discovery: Promise<Discovery> | undefined;
  #session: Session | undefined;
  #refreshing: Promise<void> | undefined;
  #starting: Promise<SignInResult> | undefined;
  #snapshot: SessionSnapshot = Object.freeze({
    status: "loading",
    claims: null,
    error: null,
  });

  constructor(options: CanopyBrowserClientOptions) {
    if (!options.issuer || !options.clientId || !options.redirectUri) {
      throw new TypeError(
        "createCanopyBrowserClient needs an issuer, a clientId and a redirectUri.",
      );
    }

    this.#issuer = withoutTrailingSlashes(options.issuer);
    this.#clientId = options.clientId;
    this.#redirectUri = options.redirectUri;
    this.#scopes = options.scopes ?? DEFAULT_SCOPES;
    this.#postLogoutRedirectUri = options.postLogoutRedirectUri;
    this.#leewayMs = (options.refreshLeewaySeconds ?? 60) * 1000;
    this.#onSessionEnd = options.onSessionEnd;
    this.#storageOption = options.storage;
    this.#navigate = options.navigate ?? ((url) => location.assign(url));
    this.#replaceUrl =
      options.replaceUrl ??
      ((url) => history.replaceState(history.state, "", url));
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#permissions = new PermissionChecks({
      apiOrigin: () => new URL(this.#issuer).origin,
      accessToken: () => this.getAccessToken(),
      claims: () => this.#session?.accessClaims ?? null,
      fetch: this.#fetch,
      now: this.#now,
      changed: () => this.#emit(),
    });
  }

  /**
   * Run when the app loads. Finishes a sign-in when Canopy has just sent the
   * browser back, and otherwise tries to resume Canopy's session without
   * showing a page, coming back to the page it left. Show your sign-in button
   * on `signed-out`, and on `error` when `error.needsSignIn`.
   *
   * Calls share one run: a second call while the first is under way, or
   * after it settled, returns the same result, so a framework that runs its
   * effects twice exchanges the code once and redirects never.
   */
  start(options: StartOptions = {}): Promise<SignInResult> {
    // A run that failed to reach Canopy settles nothing, so the next call
    // tries again.
    this.#starting ??= this.#start(options).catch((caught: unknown) => {
      this.#starting = undefined;

      throw caught;
    });

    return this.#starting;
  }

  async #start(options: StartOptions): Promise<SignInResult> {
    const url = options.url ?? location.href;

    if (hasResponse(url)) {
      return this.handleRedirect(url);
    }

    if (this.#session) {
      return { status: "signed-in", returnTo: undefined };
    }

    if (options.resume === false) {
      this.#setSnapshot("signed-out", null);

      return { status: "signed-out" };
    }

    const page = new URL(url);

    await this.signIn({
      prompt: "none",
      returnTo: `${page.pathname}${page.search}${page.hash}`,
    });

    return { status: "redirecting" };
  }

  /** Send the browser to Canopy's sign-in. */
  async signIn(signIn: SignInOptions = {}): Promise<void> {
    const discovery = await this.#discover();
    const { verifier, challenge } = await createPkcePair();
    const state = randomString();
    const nonce = randomString();
    const pending: Pending = { verifier, nonce };

    if (signIn.returnTo !== undefined) {
      pending.returnTo = signIn.returnTo;
    }

    this.#storage().setItem(this.#pendingKey(state), JSON.stringify(pending));

    const authorize = new URL(discovery.authorization_endpoint);

    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      scope: this.#scopes.join(" "),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(signIn.prompt ? { prompt: signIn.prompt } : {}),
      ...(signIn.organization ? { organization: signIn.organization } : {}),
      ...(signIn.loginHint ? { login_hint: signIn.loginHint } : {}),
      ...(signIn.uiLocales ? { ui_locales: signIn.uiLocales } : {}),
    }).toString();

    this.#navigate(authorize.toString());
  }

  /**
   * Finish the sign-in Canopy just sent the browser back from: check `state`
   * against this browser's own request, exchange the code with the client id
   * and the PKCE verifier, and take the response parameters out of the URL.
   */
  async handleRedirect(url: string = location.href): Promise<SignInResult> {
    const current = new URL(url);
    const params = current.searchParams;
    const state = params.get("state");

    if (!hasResponse(url)) {
      this.#setSnapshot("signed-out", null);

      return { status: "signed-out" };
    }

    this.#replaceUrl(withoutResponse(current));

    const pending = state ? this.#takePending(state) : undefined;

    if (!pending) {
      return this.#failed(
        new CanopyAuthError(
          "state_mismatch",
          "The response does not answer a sign-in this browser started.",
        ),
        undefined,
      );
    }

    const error = params.get("error");

    if (error) {
      return this.#failed(
        new CanopyAuthError(
          error,
          params.get("error_description") ?? undefined,
        ),
        pending.returnTo,
      );
    }

    try {
      const tokens = await this.#token({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: this.#redirectUri,
        code_verifier: pending.verifier,
      });

      this.#keep(tokens, pending.nonce);

      return { status: "signed-in", returnTo: pending.returnTo };
    } catch (caught) {
      if (caught instanceof CanopyAuthError) {
        return this.#failed(caught, pending.returnTo);
      }

      throw caught;
    }
  }

  /**
   * Listen for the session changing, and for a permission answer arriving or
   * the held answers clearing. Returns the function that stops listening.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The session now. The same object until it changes; see `subscribe`. */
  getSnapshot(): SessionSnapshot {
    return this.#snapshot;
  }

  /** Whether tokens are in memory. */
  isSignedIn(): boolean {
    return this.#session !== undefined;
  }

  /**
   * A current access token for `Authorization: Bearer`, refreshed first when
   * it is about to expire. `null` when nobody is signed in, or the session has
   * ended (its lifetime ran out or it was revoked).
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.#session) {
      return null;
    }

    if (this.#session.expiresAt - this.#leewayMs <= this.#now()) {
      try {
        await this.refresh();
      } catch (caught) {
        if (caught instanceof CanopyAuthError) {
          return null;
        }

        throw caught;
      }
    }

    return this.#session?.accessToken ?? null;
  }

  /**
   * Trade the refresh token for new tokens now. Concurrent calls share one
   * request, so the rotated token is never presented twice from this page.
   * A refused refresh ends the session in memory and calls `onSessionEnd`.
   */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });

    return this.#refreshing;
  }

  /**
   * The signed-in person's ID token claims, or `null`. `TCustom` names the
   * Environment's custom claims marked for the ID token, each optional:
   * `getClaims<{ plan?: string }>()?.plan`.
   */
  getClaims<TCustom extends object = object>():
    (IdTokenClaims & TCustom) | null {
    return (
      (this.#session?.claims as (IdTokenClaims & TCustom) | undefined) ?? null
    );
  }

  /**
   * The current access token's claims, or `null`: its `permissions`,
   * `org_id`, `org_roles`, `org_permissions` and custom claims. For display
   * and gating only; the browser cannot check the token's signature.
   */
  getAccessTokenClaims<TCustom extends object = object>():
    (AccessTokenClaims & TCustom) | null {
    return (
      (this.#session?.accessClaims as
        (AccessTokenClaims & TCustom) | undefined) ?? null
    );
  }

  /**
   * Whether the signed-in person holds `permission`: at `nodeId` (walking its
   * ancestors), or anywhere in the Environment without one. For deciding what
   * a page shows; your API still authorizes every request.
   *
   * Answered from the access token when it can say (an Environment-wide check
   * from `permissions`, a check at the session's organization from
   * `org_permissions`), else by the API. Checks asked for in the same tick go
   * in one request, and an answer is held until the token is refreshed, the
   * organization changes or the person signs out.
   */
  checkPermission(
    permission: string,
    options: { nodeId?: string } = {},
  ): Promise<boolean> {
    return this.#permissions.check(checkOf(permission, options.nodeId));
  }

  /** `checkPermission` for several checks at once, answered in their order. */
  checkPermissions(checks: readonly PermissionCheck[]): Promise<boolean[]> {
    return Promise.all(
      checks.map((check) =>
        this.#permissions.check(checkOf(check.permission, check.nodeId)),
      ),
    );
  }

  /**
   * What is known about a check now, without asking for it: `loading` until
   * an answer arrives. Stable until it changes; `subscribe` says when.
   */
  getPermissionState(
    permission: string,
    options: { nodeId?: string } = {},
  ): PermissionState {
    return this.#permissions.state(checkOf(permission, options.nodeId));
  }

  /**
   * Every permission key the signed-in person holds anywhere in the
   * Environment, held like a check. Empty when nobody is signed in.
   */
  listPermissions(): Promise<string[]> {
    return this.#permissions.list();
  }

  /**
   * Sign out of the app and of Canopy: revoke the refresh token, forget the
   * tokens, then send the browser to Canopy's end-session endpoint with the
   * ID token as the hint. Skipping the second half would let the next
   * `start()` sign the person straight back in.
   */
  async signOut(): Promise<void> {
    const session = this.#session;
    const discovery = await this.#discover();

    this.#ended(null);

    if (session?.refreshToken && discovery.revocation_endpoint) {
      try {
        await this.#post(discovery.revocation_endpoint, {
          token: session.refreshToken,
          token_type_hint: "refresh_token",
        });
      } catch {
        // Ending the session at Canopy below revokes this sign-in's refresh
        // tokens too, so a failed revocation is not worth stopping for.
      }
    }

    if (!discovery.end_session_endpoint) {
      return;
    }

    const endSession = new URL(discovery.end_session_endpoint);
    const query = new URLSearchParams({ client_id: this.#clientId });

    if (session) {
      query.set("id_token_hint", session.idToken);
    }

    if (this.#postLogoutRedirectUri) {
      query.set("post_logout_redirect_uri", this.#postLogoutRedirectUri);
    }

    endSession.search = query.toString();
    this.#navigate(endSession.toString());
  }

  async #refresh(): Promise<void> {
    const session = this.#session;

    if (!session?.refreshToken) {
      throw new CanopyAuthError(
        "invalid_grant",
        "There is no refresh token to use.",
      );
    }

    try {
      const tokens = await this.#token({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });

      this.#keep(tokens, undefined, session);
    } catch (caught) {
      if (caught instanceof CanopyAuthError) {
        this.#ended(caught);
        this.#onSessionEnd?.(caught);
      }

      throw caught;
    }
  }

  #keep(
    tokens: TokenResponse,
    nonce: string | undefined,
    previous?: Session,
  ): void {
    const idToken = tokens.id_token ?? previous?.idToken;

    if (!idToken) {
      throw new CanopyAuthError(
        "invalid_token",
        "The token response carried no ID token. Ask for the openid scope.",
      );
    }

    const claims = tokens.id_token
      ? checkIdToken(
          tokens.id_token,
          { issuer: this.#issuer, clientId: this.#clientId, nonce },
          Math.floor(this.#now() / 1000),
        )
      : (previous as Session).claims;

    this.#session = {
      accessToken: tokens.access_token,
      accessClaims: accessClaimsOf(tokens.access_token),
      expiresAt: this.#now() + (tokens.expires_in ?? 0) * 1000,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      idToken,
      claims,
    };

    // A new token can carry other permissions: answers held for the old one
    // no longer stand.
    this.#permissions.clear();
    this.#setSnapshot("signed-in", null);
  }

  /** The session is over: nobody is signed in, and nothing held stands. */
  #ended(error: CanopyAuthError | null): void {
    this.#session = undefined;
    this.#starting = undefined;
    this.#permissions.clear();
    this.#setSnapshot("signed-out", error);
  }

  #failed(error: CanopyAuthError, returnTo: string | undefined): SignInResult {
    this.#setSnapshot(this.#session ? "signed-in" : "signed-out", error);

    return { status: "error", error, returnTo };
  }

  #setSnapshot(
    status: SessionSnapshot["status"],
    error: CanopyAuthError | null,
  ): void {
    this.#snapshot = Object.freeze({
      status,
      claims: status === "signed-in" ? (this.#session?.claims ?? null) : null,
      error,
    });
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  #storage(): PendingStorage {
    return this.#storageOption ?? sessionStorage;
  }

  async #token(body: Record<string, string>): Promise<TokenResponse> {
    const discovery = await this.#discover();

    return (await this.#post(discovery.token_endpoint, body)) as TokenResponse;
  }

  async #post(url: string, body: Record<string, string>): Promise<unknown> {
    let response: Response;

    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...body, client_id: this.#clientId }),
      });
    } catch (caught) {
      throw new CanopyConnectionError(url, caught);
    }

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const failure = parsed as { error?: string; error_description?: string };

      throw new CanopyAuthError(
        failure.error ?? "server_error",
        failure.error_description,
        response.status,
      );
    }

    return parsed;
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= this.#readDiscovery().catch((caught: unknown) => {
      this.#discovery = undefined;

      throw caught;
    });

    return this.#discovery;
  }

  async #readDiscovery(): Promise<Discovery> {
    const url = `${this.#issuer}/.well-known/openid-configuration`;
    let response: Response;

    try {
      response = await this.#fetch(url);
    } catch (caught) {
      throw new CanopyConnectionError(url, caught);
    }

    if (!response.ok) {
      throw new CanopyAuthError(
        "invalid_issuer",
        `${url} answered ${response.status}. Check the issuer.`,
        response.status,
      );
    }

    const discovery = (await response.json()) as Discovery;

    // OpenID Connect Discovery 4.3: the document must name the issuer it was
    // fetched for, or its endpoints belong to someone else.
    if (discovery.issuer !== this.#issuer) {
      throw new CanopyAuthError(
        "invalid_issuer",
        `The discovery document names ${discovery.issuer}, not ${this.#issuer}.`,
      );
    }

    return discovery;
  }

  #pendingKey(state: string): string {
    return `canopy.browser.${this.#clientId}.${state}`;
  }

  #takePending(state: string): Pending | undefined {
    const key = this.#pendingKey(state);
    const storage = this.#storage();
    const raw = storage.getItem(key);

    storage.removeItem(key);

    return raw ? (JSON.parse(raw) as Pending) : undefined;
  }
}

/**
 * The issuer with any trailing slashes removed, so `…/env-1/` and `…/env-1`
 * name the same issuer. A loop rather than a regular expression: the value
 * is the caller's, and an anchored `/+$` backtracks on a long run of slashes.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
}

function checkOf(
  permission: string,
  nodeId: string | undefined,
): PermissionCheck {
  return nodeId === undefined ? { permission } : { permission, nodeId };
}

/**
 * The access token's claims, or null when it is not a JWT this client can
 * read. Read for gating only, so a token it cannot read is not an error:
 * checks are then asked of the API.
 */
function accessClaimsOf(token: string): AccessTokenClaims | null {
  try {
    return decodeJwtPayload(token) as AccessTokenClaims;
  } catch {
    return null;
  }
}

function hasResponse(url: string): boolean {
  const params = new URL(url).searchParams;

  return params.has("state") && (params.has("code") || params.has("error"));
}

function withoutResponse(url: URL): string {
  const clean = new URL(url.toString());

  for (const name of RESPONSE_PARAMS) {
    clean.searchParams.delete(name);
  }

  return clean.toString();
}
