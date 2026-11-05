# Mistakes to look for

Each entry: what goes wrong, and what to write instead. Use this list when reviewing an existing integration.

## Decoding a token instead of verifying it

`jwt.decode(token)`, or reading the payload with `atob`, accepts a forged token. Verify with `TokenVerifier`, or `CanopyTokenGuard` in NestJS. It also pins RS256, so `alg: none` and HMAC key confusion cannot get in.

## The wrong `audience` for the sign-in shape

A Hosted Login access token carries `aud`, your OAuth `client_id`; a Direct API token carries none. A verifier without `audience` rejects every Hosted Login token with `token.audience_unverified`, and one with `audience` rejects every Direct API token with `token.audience_mismatch`. Set it for Hosted Login, leave it unset for the Direct API, and never "fix" either error by skipping the check: `aud` is what stops a token minted for another client being accepted by your backend.

## Verifying without naming the issuer

Each Environment is its own issuer. A verifier for the wrong Environment rejects every token, and code that skips the issuer check accepts tokens from other Environments. Pass `environmentId`, or `issuer` for a custom auth domain.

## A provider's OAuth flow built beside Canopy

Signing people in with Google through `passport`, NextAuth or the provider's own SDK, then matching the email to a Canopy identity, leaves the application holding no Canopy token and duplicates what Canopy does: verifying the provider's answer, trusting only an email the provider verified, linking, and applying the organization's sign-in policy and MFA. Enable the provider for the Environment in the Console instead, and use the hosted button or the Direct API start URL ([choosing.md](choosing.md)).

## A sign-in `state` that is not tied to the browser

A social sign-in's `state` kept in a server-side set or map of pending states, and accepted from any request that presents one, protects nothing: an attacker starts a sign-in with their own provider account, takes the `state` and `sso_token` from their own return URL, and sends someone else that link, who ends up signed in as the attacker. Keep the `state` in the browser that started the sign-in (an httpOnly, `SameSite=Lax` cookie, or that browser's session) and compare against it on return.

## A social sign-in's refusal treated as a crash

A Direct API social sign-in returns to `return_url` with `error` when Canopy refuses it, and `POST /v1/identity/auth/sso/authenticate` can still refuse the session. Show the reason on the sign-in page; do not retry, and do not fall back to creating the account yourself. The codes: `social.no_identity` (no account with that email and self-signup is off, or the account is not a member of this Environment), `social.email_unverified` (the provider did not verify the email, so it can neither link nor create an account), `social.identity_sso_managed` (the account signs in through its organization's SSO), `auth.account_deactivated`, `social.provider_not_enabled`, `social.sign_in_invalid` (the provider's answer failed verification) and `social.provider_unavailable`. An organization whose policy does not allow the provider refuses at `sso/authenticate` with `403 organization.sign_in_method_not_allowed`, or `403 organization.sso_required` when it requires SSO. Always check the `state` you sent before reading anything else on the return URL.

## A WebAuthn flow built beside Canopy

Registering passkeys and verifying assertions in the application (with `@simplewebauthn/server` or any other library), then looking the person up in Canopy, leaves the application holding no Canopy session and storing credentials of its own. Canopy already keeps the passkey as the identity's second factor and verifies it: run only the browser ceremony against Canopy's options (`/login/passkey/options` and `/verify`, [choosing.md](choosing.md)), or let the hosted page do it.

## A passkey sign-in's refusal treated as a crash

`POST /v1/identity/auth/login/passkey/options` and `/verify` refuse by code. Show the reason and offer the other ways in; never retry with the same `passkey_token`, and treat a dismissed browser prompt (`NotAllowedError`) as nothing to report. The codes: `403 auth.passkey_login_disabled` (the Environment has passkey sign-in off: read `passkey_login_enabled` from `GET /v1/identity/auth/config` and show no button), `401 auth.passkey_sign_in_expired` (the token was spent, expired after five minutes, or belongs to another Environment: start again from `options`), `401 auth.passkey_user_verification_required` (the authenticator did not check it was the person, so it cannot sign in alone), and `401 auth.invalid_credentials` (a passkey Canopy does not know, one bound to another relying party, or a signature that did not verify). An organization whose policy does not allow passkeys refuses with `403 organization.sign_in_method_not_allowed`.

## An account key in a running backend or a browser

An account key acts on the whole Account and in every Environment of it. In a backend's environment variables it turns any leak of that service into control of the Account; in a browser it is public. A backend uses an Environment key for its own Environment; an account key lives only in a provisioning script or CI secret ([choosing.md](choosing.md)).

## An Environment route called with an account key and no Environment

An account key does not know which Environment to act in. Without `X-Canopy-Environment` every Environment-level route (roles, identities, auth settings, webhooks) answers `400 api_key.environment_required`. Set `environmentId` on the client, or on the call ([node.md](node.md)); the Account's own routes need none.

## An account key holding `admin_governance.manage` it does not need

A key with `admin_governance.manage` composes and grants administrator roles. Canopy refuses a role or grant beyond the key's own scopes, and never lets a key hand out governance itself, but within those bounds the key decides who administers the Account. Give it only to a script whose job is administration; a script that provisions Environments needs `application.manage` and the settings scopes, not governance.

## Calling `evaluate` on every request

`canopy.permissions.evaluate` in a hot path puts Canopy in every request: latency, rate limits, and an outage that takes the application down with it. Use `CanopyGuard` or `LocalAuthorizer`. Keep `evaluate` for a single decision that must have no staleness.

## Treating "could not decide" as "denied", or as "allowed"

Catching every authorization error and returning `403` hides an outage and a misconfiguration behind what looks like policy. Catching and allowing is worse. Map them apart: `403` denied, `503` Canopy unreachable, `500` broken integration. See the `statusFor` function in [express.md](express.md).

## A fresh verifier or authorizer per request

`new TokenVerifier()` or `new LocalAuthorizer()` inside a handler discards the key-set and grant caches each time, so every request goes to the network. Create them once per process.

## `app_wide` on a resource that belongs to a node

`scope: "app_wide"` asks whether the identity holds the permission **anywhere**. Guarding a document that belongs to one region that way lets someone from another region in. Use the default `node` scope at the resource's node.

## Checking a node other than the one the action writes to

A guard is only as narrow as the node it checks. Checking at the organization, the region or any other ancestor because the person holds the permission "somewhere in there" lets them act on every record beneath it. `authorizer.holdsAnywhereUnder(identityId, permission, nodeId)` and `scope: "app_wide"` answer that "somewhere" question for showing a menu; neither is a guard. Check the node the action writes to: the record's own node, with the default `node` scope.

## A node or organization taken from the caller

A `node_id` or `org_id` read from a query string, header or request body lets the caller pick where their check runs. Take the organization from the verified token, and the node from the route plus your own records.

## A secret in the browser

A `cnpy_…` API key or an OAuth client secret in front-end code, or in an environment variable prefixed for the browser (`NEXT_PUBLIC_`, `VITE_`). Only the `pk_…` publishable key, the `client_id` and the issuer URL are public.

## Mishandling the refresh token

Storing a `web` refresh token in `localStorage` (it is an httpOnly cookie for a reason), parsing it, or keeping an old one after a refresh. Replaying a rotated refresh token through the Direct API revokes every session the identity holds; through Hosted Login it ends that sign-in's session. A backend proxy overwrites its stored token on every refresh.

## A public client's tokens in `localStorage`

A public client has no secret, which is not permission to keep its tokens where any script on the page can read them. Keep them in memory (`@canopy-io/browser` does), and get new ones after a reload with `prompt=none` ([spa.md](spa.md)). `sessionStorage` holds only the PKCE verifier for the round trip.

## The wrong client type

An app with a backend registered as a public client puts tokens in the browser for no reason; a single-page app with no backend registered as a confidential one ships the secret to the browser, which makes it public anyway. Pick by where the code exchange runs. A public client that sends a secret is refused with `invalid_client`, and the type cannot change after registration: register a new client.

## A silent sign-in that retries

`prompt=none` answered with `login_required` or `interaction_required` means the person has to sign in. Show the sign-in button; retrying silently loops. Sign out through both `/oauth/revoke` and the end-session endpoint, or the next silent attempt signs the person straight back in.

## Webhooks verified over re-serialized JSON

`JSON.stringify(req.body)` is not the body that was signed. Keep the raw bytes for the HMAC, compare in constant time, and compare each value of `X-Canopy-Signature` separately, so the second value during a secret rotation still matches.

## A custom claim read as complete when the token says it overflowed

The custom claims an Environment maps onto a token are added in order within a size limit; the ones past it are left off and the token carries `custom_claims_overflow: true`. Code that reads `claims.plan` and treats its absence as "no plan" then denies a Pro customer whose claim did not fit. Keep every custom claim optional, treat an absent one as "not set", and when `custom_claims_overflow` is true read the value from the API (the identity's or organization's metadata) instead of the token.

## A token used as a database

Mapping a dozen metadata keys onto the access token to save a request puts a few kilobytes in every `Authorization` header and runs into the claims' size limit, where the later claims are silently left off. Map the few facts a request must decide on (`plan`, a tenant's tier), keep names you cannot change (the reserved ones are refused on save), and read the rest from the API when a request needs it.

## A scoped API key without the read scopes

The guard and `LocalAuthorizer` read grant roots (`identity.view`) and the hierarchy (`hierarchy.view`). Missing either one shows up as `500`s on guarded routes. Add the scopes; do not catch the error.
