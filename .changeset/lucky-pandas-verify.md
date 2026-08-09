---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

Verify Canopy access tokens locally, and guard a route with the result.

`TokenVerifier` checks Canopy's RS256 signatures against the published key set: one JWKS fetch, then a signature check per request with no network at all. Authorization asks the API a question; authentication does not need to.

```ts
const verifier = new TokenVerifier();
const claims = await verifier.verify(bearerToken);
```

The traps are why this ships rather than being left to each caller. The algorithm is pinned, so `alg: none` and HMAC key-confusion cannot get in. Refetches triggered by an unknown `kid` are floored, so a forged header cannot amplify one inbound request into one outbound fetch — and the same floor applies when the key set is empty or stale, which is the case an issuer outage produces. The JWKS read is bounded by a deadline, because verification sits on the request path and an unbounded read there is an unbounded inbound request. A token carrying an `aud` is refused rather than ignored when no audience was configured. And a **pre-auth** token — genuine, correctly signed, issued before the user selected an Account — is refused, because treating one as a session is a privilege escalation.

`sub` and `type` are validated rather than asserted. They are declared on `CanopyTokenClaims` but arrive as parsed JSON, and a `string` that is actually `undefined` is worse than a rejected token because it looks like an answer.

**`CanopyTokenGuard`** (`@canopy-io/nestjs`) applies this to a route and attaches the claims, for applications with no auth layer in front:

```ts
@UseGuards(CanopyTokenGuard, CanopyGuard)
@RequirePermission("documents.read")
findAll() {}
```

Order matters — `CanopyGuard` reads what `CanopyTokenGuard` attached. Claims land on `request.canopyToken`, not `request.user`, which belongs to Passport. Skip the guard entirely if you already run your own JWT middleware; nothing else depends on it.

A rejected token is a `401` whatever the detail. The exception is `token.jwks_unavailable`, which answers **503**: not being able to verify is not the same as failing to verify, the caller's token may be perfectly good, and telling a client its token is stale during a key-server outage only aims a refresh storm at the thing that is already down.
