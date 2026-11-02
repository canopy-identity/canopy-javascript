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

Storing a `web` refresh token in `localStorage` (it is an httpOnly cookie for a reason), parsing it, or keeping an old one after a refresh. Replaying a rotated refresh token revokes every session the identity holds. A backend proxy overwrites its stored token on every refresh.

## Webhooks verified over re-serialized JSON

`JSON.stringify(req.body)` is not the body that was signed. Keep the raw bytes for the HMAC, compare in constant time, and compare each value of `X-Canopy-Signature` separately, so the second value during a secret rotation still matches.

## A scoped API key without the read scopes

The guard and `LocalAuthorizer` read grant roots (`identity.view`) and the hierarchy (`hierarchy.view`). Missing either one shows up as `500`s on guarded routes. Add the scopes; do not catch the error.
