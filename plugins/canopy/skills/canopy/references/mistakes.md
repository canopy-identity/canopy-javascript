# Mistakes to look for

Each entry: what goes wrong, and what to write instead. Use this list when reviewing an existing integration.

## Decoding a token instead of verifying it

`jwt.decode(token)`, or reading the payload with `atob`, accepts a forged token. Verify with `TokenVerifier`, or `CanopyTokenGuard` in NestJS. It also pins RS256, so `alg: none` and HMAC key confusion cannot get in.

## The wrong `audience` for the sign-in shape

A Hosted Login access token carries `aud`, your OAuth `client_id`; a Direct API token carries none. A verifier without `audience` rejects every Hosted Login token with `token.audience_unverified`, and one with `audience` rejects every Direct API token with `token.audience_mismatch`. Set it for Hosted Login, leave it unset for the Direct API, and never "fix" either error by skipping the check: `aud` is what stops a token minted for another client being accepted by your backend.

## Verifying without naming the issuer

Each Environment is its own issuer. A verifier for the wrong Environment rejects every token, and code that skips the issuer check accepts tokens from other Environments. Pass `environmentId`, or `issuer` for a custom auth domain.

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
