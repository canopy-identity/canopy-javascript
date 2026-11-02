# Choosing a sign-in shape

Two independent choices: who renders the sign-in screen, and where the refresh token lives. Settle both with the user before writing code.

## Who renders the sign-in screen

### Direct API

The application renders its own form and calls Canopy's identity endpoints. The publishable key (`pk_…`) goes in the JSON body, never a header.

- Sign in: `POST /v1/identity/auth/login` with `{ publishable_key, email, password }`. The response is a `{ data }` envelope holding `access_token`, `expires_in` (900 seconds by default) and the `identity`. There is no ID token.
- Refresh, sign out, account management and organization switching are also under `/v1/identity/auth/*`.
- Email one-time codes (`/login/email-otp/start` and `/verify`) and self-signup (`/register`) exist but are off until the Environment turns them on.
- Read sign-in options and the password policy from `GET /v1/identity/auth/config?publishable_key=…` rather than hard-coding them.
- SSO from a Direct API app: `POST /v1/identity/auth/sso/resolve`, send the browser to the returned start URL, and exchange the `sso_token` it comes back with at `POST /v1/identity/auth/sso/authenticate`.
- Social sign-in from a Direct API app: the enabled providers are `social_providers` on `GET /v1/identity/auth/config` (each with a `slug`, its `kind` and a `display_name`), so the page shows exactly those buttons. A button sends the browser to `GET /v1/identity/auth/social/<slug>/start` with `publishable_key`, `return_url` and a `state` you keep; `return_url` must match one of the Environment's **Redirect URLs** exactly. The browser comes back with `sso_token` and your `state`, or `error` and your `state`: check `state`, then exchange the token at `POST /v1/identity/auth/sso/authenticate` as after SSO. The session's `amr` is `["fed", "google"]`, or `["fed", "oidc:<name>"]` for a custom provider.
- Linked providers on an account screen: `GET /v1/identity/auth/social-links` lists the identity's linked accounts. `POST /v1/identity/auth/social-links/<slug>/start` with `{ return_url, state, current_password }` answers `{ authorization_url }` for the browser; it comes back with `linked=<slug>` or `error=<code>`. `DELETE /v1/identity/auth/social-links/<id>` unlinks one. Both re-verify the person: the current password when the identity has one, plus `x-mfa-step-up-token` from `POST /v1/identity/auth/mfa/step-up` when it has a second factor or no password (an identity with neither gets a code by `POST /v1/identity/auth/mfa/step-up/email`).

### Hosted Login (OAuth 2.0 and OIDC)

Canopy renders sign-in, MFA and SSO. The application is a confidential OAuth client.

- Register a client in the Console: a `client_id`, a secret shown once, exact-match HTTPS redirect URIs, and scopes.
- Redirect to `/oauth/authorize` with PKCE (S256), `state` and optionally `nonce`. Canopy redirects back with a `code`; the backend exchanges it at `/oauth/token` with the client secret.
- The token response is plain OAuth: `access_token`, `id_token` and an opaque `refresh_token`. Both JWTs carry `aud`, your `client_id`: verify the access token's issuer, audience and `type`.
- Refresh with `grant_type=refresh_token` at `/oauth/token`. Sign out with both `/oauth/revoke` and the `end_session_endpoint` (with `id_token_hint`).
- A standard OIDC library (for example `openid-client`) drives the flow; read endpoints from the issuer's discovery document rather than building URLs.
- Social providers the Environment enables appear as buttons on the hosted sign-in and sign-up pages, and the person links or unlinks them on the hosted security page. The application builds nothing for them; their tokens carry `amr` `["fed", "<provider>"]`.

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

## Finding the issuer and Environment id

Each Environment is its own issuer: `https://<api origin>/environments/<environment_id>`, or `https://<custom auth domain>` once one is active. The Console shows the issuer, discovery and JWKS URLs under Authentication → Signing keys, and every OAuth client response includes `issuer`. Pass `environmentId` to `TokenVerifier` for the default issuer, or `issuer` for a custom domain or a self-hosted instance. A self-hosted instance can instead set `CANOPY_BASE_URL` for the process: the client calls it and `environmentId` resolves under it, so the code stays what it is on hosted Canopy.

## Credentials, in one place

| Value                                                 | Where it may live                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cnpy_…` API key                                      | Server only. One credential per request: sending an API key and a bearer token together answers `400`. |
| OAuth client secret                                   | Server only                                                                                            |
| `pk_…` publishable key, OAuth `client_id`, issuer URL | Anywhere, including browser bundles                                                                    |
