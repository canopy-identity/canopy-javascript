# Choosing a sign-in shape

Two independent choices: who renders the sign-in screen, and where the refresh token lives. Settle both with the user before writing code.

## Who renders the sign-in screen

### Direct API

The application renders its own form and calls Canopy's identity endpoints. The publishable key (`pk_…`) goes in the JSON body, never a header.

- A browser calling these endpoints directly must run on a site the Environment lists under its own **Allowed web origins**; any other site, including one another Environment lists, is refused with `403 auth.origin_not_allowed`. A request with no `Origin` (a backend, a mobile app) is not judged, and a backend that forwards its browser's `Origin` passes with the Environment's secret API key.

- Sign in: `POST /v1/identity/auth/login` with `{ publishable_key, email, password }`. The response is a `{ data }` envelope holding `access_token`, `expires_in` (900 seconds by default) and the `identity`. There is no ID token.
- Refresh, sign out, account management and organization switching are also under `/v1/identity/auth/*`.
- Email one-time codes (`/login/email-otp/start` and `/verify`), passkey sign-in (`/login/passkey/options` and `/verify`) and self-signup (`/register`) exist but are off until the Environment turns them on.
- Read sign-in options and the password policy from `GET /v1/identity/auth/config?publishable_key=…` rather than hard-coding them (the key goes in the query string, never a header; without one the call answers `400 auth.publishable_key_required`): `password_login_enabled`, `email_otp_login_enabled`, `passkey_login_enabled`, `social_providers`, and `sso_login_enabled` (an end-user SSO connection is bound, so an email can lead to a provider). With password and email codes off and no SSO, an email leads nowhere: show only the passkey and provider buttons.
- SSO from a Direct API app: `POST /v1/identity/auth/sso/resolve`, send the browser to the returned start URL, and exchange the `sso_token` it comes back with at `POST /v1/identity/auth/sso/authenticate`. A token that is invalid, already used or for another Environment answers `401 auth.sso_token_invalid`: start the sign-in again.
- The signed-in person's profile is `GET /v1/identity/auth/me`. `has_password` tells you which proof a step-up takes for someone with no second factor. When `email_managed_by_sso` is true the identity provider owns the address, so leave out any way to change it.
- CAPTCHA on a Direct API form, where the Environment requires it: load `<api origin>/auth/static/canopy-captcha.js`, render `<canopy-captcha publishable-key="pk_…" flow="login" api-base="<api origin>">`, and send `el.token` as `captcha_token` on the login or register call (`@canopy-io/browser` exports the element's types as `CanopyCaptchaElement`). No token answers `auth.captcha_required`, a bad one `auth.captcha_failed`. A token is accepted once, so call `el.reset()` after a refused attempt. The widget's two reads answer any origin; a page with a strict Content-Security-Policy must allow the API origin in `script-src` and `connect-src`, and `worker-src blob:`.
- Social sign-in from a Direct API app: the enabled providers are `social_providers` on `GET /v1/identity/auth/config` (each with a `slug`, its `kind` and a `display_name`), so the page shows exactly those buttons. A button sends the browser to `GET /v1/identity/auth/social/<slug>/start` with `publishable_key`, `return_url` and a random `state`; `return_url` must match one of the Environment's **Redirect URLs** exactly. Keep the `state` in the browser that started the sign-in (an httpOnly cookie, or that browser's own session), never only in a server-side list of pending states. The browser comes back with `sso_token` and your `state`, or `error` and your `state`: compare `state` with the one that browser holds, refuse a mismatch or a browser that holds none, then exchange the token at `POST /v1/identity/auth/sso/authenticate` as after SSO. The session's `amr` is `["fed", "google"]`, or `["fed", "oidc:<name>"]` for a custom provider.
- Passkey sign-in from a Direct API app, where `passkey_login_enabled` is on: `POST /v1/identity/auth/login/passkey/options` with `{ publishable_key }` answers `{ passkey_token, options }`. In the browser, pass `options` to `startAuthentication({ optionsJSON: options })` from `@simplewebauthn/browser` (or to `navigator.credentials.get()`), then send `POST /v1/identity/auth/login/passkey/verify` with `{ publishable_key, passkey_token, response }`, `response` being the credential's JSON. The answer is the same session as password login, and its `amr` is `["hwk", "mfa"]`: the passkey is both factors, so no MFA challenge follows. There is no email first: the browser offers the passkeys it holds for the page's domain, and the one chosen names the identity. Give the email field `autocomplete="username webauthn"` and also start a ceremony with `useBrowserAutofill: true` as the page loads, so the passkeys appear in the field's suggestions. The passkey is one the person added as a second factor (Canopy's MFA enrolment, no separate registration), and it must be bound to the relying party the page runs under: on your own domain, the Environment's `webauthn_rp_id` and `webauthn_origins`. Each `passkey_token` is good for one verify within five minutes.
- Linked providers on an account screen: `GET /v1/identity/auth/social-links` lists the identity's linked accounts. `POST /v1/identity/auth/social-links/<slug>/start` with `{ return_url, state, current_password }` answers `{ authorization_url }` for the browser; it comes back with `linked=<slug>` or `error=<code>`. `DELETE /v1/identity/auth/social-links/<id>` unlinks one. Both re-verify the person: the current password when the identity has one, plus `x-mfa-step-up-token` from `POST /v1/identity/auth/mfa/step-up` when it has a second factor or no password (an identity with neither gets a code by `POST /v1/identity/auth/mfa/step-up/email`).

### Hosted Login (OAuth 2.0 and OIDC)

Canopy renders sign-in, MFA and SSO. The application is an OAuth client, of one of two types chosen at registration and never changed:

- **Confidential** (the default): a backend holds the client secret and exchanges the code. Use it whenever the app has a server, including a single-page app with a backend for frontend.
- **Public**: a single-page app with no backend, or a mobile or desktop app. No secret: it sends its `client_id` alone (`token_endpoint_auth_method: none`), and PKCE binds the code to the browser. It may hold only the `authorization_code` and `refresh_token` grants. Its session ends a fixed time after sign-in (30 days by default) however often it refreshes. A browser app uses `@canopy-io/browser` ([spa.md](spa.md)) and adds its origin to that Environment's own **Allowed web origins** (a public client calling `/oauth/token` from any other site is refused with `403 access_denied`); a native app opens the system browser and registers a custom-scheme (`com.example.app:/callback`) or loopback redirect URI.

For either:

- Register a client in the Console: a `client_id`, for a confidential client a secret shown once, exact-match redirect URIs, and scopes.
- Redirect to `/oauth/authorize` with PKCE (S256), `state` and optionally `nonce`. Canopy redirects back with a `code`; a confidential client's backend exchanges it at `/oauth/token` with the client secret, a public client with its `client_id` and the PKCE verifier.
- A browser still signed in to Canopy gets a code back with no form. `prompt=login` always shows the form; `prompt=none` shows no page and answers `login_required` or `interaction_required` when it cannot sign in silently.
- The token response is plain OAuth: `access_token`, `id_token` and an opaque `refresh_token`. Both JWTs carry `aud`, your `client_id`: verify the access token's issuer, audience and `type`.
- Refresh with `grant_type=refresh_token` at `/oauth/token`. Sign out with both `/oauth/revoke` and the `end_session_endpoint` (with `id_token_hint`).
- A standard OIDC library (for example `openid-client`) drives the flow; read endpoints from the issuer's discovery document rather than building URLs.
- Social providers the Environment enables appear as buttons on the hosted sign-in and sign-up pages, and the person links or unlinks them on the hosted security page. The application builds nothing for them; their tokens carry `amr` `["fed", "<provider>"]`.
- Where the Environment turns passkey sign-in on, the hosted sign-in page offers **Sign in with a passkey** and passkey autofill on its email field. The application builds nothing for it; the tokens carry `amr` `["hwk", "mfa"]`.

## Where the refresh token lives

A publishable key has a type, `web` or `native`, and the session keeps the delivery it started with:

- **`web`**: the refresh token arrives as an httpOnly cookie (`ca_identity_refresh_token`, `Path=/v1/identity/auth`, host-only). The access token is in the response body.
- **`native`**: the refresh token arrives in the response body, for a mobile or desktop app to keep in the OS keychain.
- **A trusted backend** that sends a secret API key (`X-API-Key: cnpy_…`) from the same Environment alongside the publishable key also receives the refresh token in the body. This is the backend proxy (BFF) pattern.

Which to use for a browser app:

| Situation                                                        | Use                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The app is served from the same site Canopy's cookies are set on | Nothing extra                                                                                                                                    |
| The app is on its own domain and the team can add a DNS record   | A **custom auth domain** (Console: Integrations → Custom Auth Domain), recommended                                                               |
| The app is on its own domain and DNS is out of the team's hands  | A **backend proxy**: the browser talks only to the app's backend, which calls Canopy with the secret key and keeps the refresh token server-side |
| Native or mobile                                                 | A **native** publishable key                                                                                                                     |

In a backend proxy, forward the end user's address and user agent as `X-Canopy-Client-IP` and `X-Canopy-Client-User-Agent`, so sessions and rate limits describe the real user rather than the server.

## Which API key goes where

Two kinds of secret API key, both `cnpy_…`:

- **An Environment key** belongs to one Environment and acts only there. A running backend holds this one: verifying tokens, authorizing, creating identities and assignments. Create it under **Access Control → Integrations → API Keys** for that Environment, with only the scopes the backend calls.
- **An account key** belongs to the Account: it manages Applications and Environments, single sign-on, administrators and billing, and acts in any Environment a request names with `X-Canopy-Environment`. Hold one only in a provisioning script or a CI job, never in a running backend or a browser. Create it under **Tenant → Account API Keys**; it is always scoped, so give it the fewest scopes the script needs ([node.md](node.md)).

## Which credential an agent holds

A key names no person, so an agent running on one acts as the key, and nothing records who asked. Choose by what the agent calls and for whom:

- **An agent inside the app, calling the app's own API**: a **machine client** (`client_kind: machine`) with its own roles, so the API authorizes it like any principal ([node.md](node.md)). Never a key: a key manages Canopy, and is never what the app's API checks.
- **The same agent acting for a signed-in person**: the machine client, with **Allow token exchange** on, exchanges the person's access token for a `delegated` one (`exchangeToken` in `@canopy-io/node`). It names both (`sub` the person, `act.sub` the client), reaches only what both hold, and every exchange is in the audit log. Never hand the agent the person's own token: it would hold everything the person holds.
- **An assistant working in Canopy for an administrator**: the account MCP server, signed in as that administrator, within their role and the capabilities they approve.
- **An agent working in Canopy on its own** (a provisioning job): a key of its own, an Environment key unless its job spans Environments, with only the scopes it calls and an expiry.

## Finding the issuer and Environment id

Each Environment is its own issuer: `https://<api origin>/environments/<environment_id>`, or `https://<custom auth domain>` once one is active. The Console shows the issuer, discovery and JWKS URLs under Authentication → Signing keys, and every OAuth client response includes `issuer`. Pass `environmentId` to `TokenVerifier` for the default issuer, or `issuer` for a custom domain or a self-hosted instance. A self-hosted instance can instead set `CANOPY_BASE_URL` for the process: the client calls it and `environmentId` resolves under it, so the code stays what it is on hosted Canopy.

## Credentials, in one place

| Value                                                 | Where it may live                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cnpy_…` API key                                      | Server only. One credential per request: sending an API key and a bearer token together answers `400`. |
| OAuth client secret (a confidential client's)         | Server only                                                                                            |
| `pk_…` publishable key, OAuth `client_id`, issuer URL | Anywhere, including browser bundles                                                                    |
