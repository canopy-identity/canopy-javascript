# @canopy-io/nestjs

## 0.2.0

### Minor Changes

- 8ad7dd0: Organizations support. Identity tokens minted in an Environment with the
  organizations container on carry `org_id` and `org_role`; both are now
  declared on `CanopyTokenClaims`, and the new `orgContext(claims)` helper
  returns the verified pair (or `null` for a token acting in no organization,
  refusing a half-present pair). `@RequirePermission` gains `scope: "org"`: the
  guard evaluates at the token's `org_id` node through the existing
  `LocalAuthorizer` — an organization is a hierarchy node and a membership is a
  role assignment at it — reading the claim off what `CanopyTokenGuard`
  attached, overridable with the new `resolveOrg` module option. A caller
  acting in no organization is denied without a network call.

### Patch Changes

- e4ca3ef: Organizations as a container: `canopy.organizations` wraps the tenant API
  (organizations, members, invitations, the per-organization sign-in policy,
  and SSO connection binding), `CanopyTokenClaims` declares `amr`, types are
  regenerated against the current spec, and the wording no longer describes
  organizations as an access model. The published spec now carries 102 operations (was 84), all additive.
- Updated dependencies [8ad7dd0]
- Updated dependencies [e4ca3ef]
  - @canopy-io/node@0.3.0

## 0.1.2

### Patch Changes

- b873daa: Fix type resolution for CommonJS consumers on `node16`/`nodenext`: the
  `exports` map now declares per-condition `types`, pointing `require` at the
  `index.d.cts` the build already emitted. Previously a `require()` that worked
  at runtime was rejected by TypeScript (TS1479), forcing dynamic-import and
  `resolution-mode` workarounds. Verified with `arethetypeswrong` across
  node10, node16-CJS, node16-ESM and bundler resolution.
- Updated dependencies [b873daa]
- Updated dependencies [13ecf63]
- Updated dependencies [003761a]
  - @canopy-io/node@0.2.0

## 0.1.1

### Patch Changes

- 89f0a46: Answer permission checks in-process instead of calling Canopy on every request.

  **Behavior change — `CanopyGuard` no longer makes a network call per guarded request.** It asks a different question, once: rather than "may this identity act _here_", it reads _where_ the identity may act and answers everything after that locally.

  Two things are held, split by what they depend on: the identity's grant roots, and one copy of your hierarchy shared by every identity in the process. A check walks up from the node in question looking for a grant root. Grant roots are never expanded through their descendants — a grant already means "this node and everything beneath it", and expanding would restate the hierarchy once per identity, largest for the near-root grants administrators hold.

  ```ts
  CanopyModule.forRoot({
    apiKey: process.env.CANOPY_API_KEY,
    authorizationTtlMs: 60_000, // the default
    resolveIdentity: (request) => request.user?.sub,
  });
  ```

  **Both are held for at most 60 seconds, which is the delay between an access change and it taking effect.** A revoked user can still act for up to a minute. The window covers everything that can alter an answer, including a moved node — reparenting changes what an inherited grant reaches even though no grant changed, so the hierarchy is revalidated on the same cadence and not a slower one.

  Set `authorizationTtlMs: 0` to switch caching off and read fresh on every check. That reinstates a round trip per request, so reach for it knowingly. For a single high-value operation, ask the API directly through the injected client instead — `canopy.permissions.evaluate` is unchanged.

  Do not shorten the window below the gap between a user's requests: every request then finds the cache expired and refetches, which is the per-request traffic this removes.

  **`LocalAuthorizer`** (`@canopy-io/node`) is the same machinery without NestJS. **`requestConditional`** sends a validator you already hold and reports whether anything changed, so something expensive can be revalidated cheaply.

  **Requires a credential that can read both halves.** A `full_access` API key already can; a scoped one needs `identity.view` and `hierarchy.view`. Without the latter the hierarchy endpoint answers an empty tree and a `200` — so a node-scoped check raises `CanopyAuthorizerError` rather than returning `false`. Not being able to see the hierarchy is not the same as the identity lacking the permission, and answering `false` there would deny every node-scoped request while looking entirely healthy.

  `CanopyGuard` still fails closed at every step. A `404` with no error code — the API not serving the grants endpoint at all — is reported as a misconfiguration rather than a denial, because denying there would take out every guarded route at once while reading as ordinary policy.

- 89f0a46: Verify Canopy access tokens locally, and guard a route with the result.

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

- bbfe8e8: Bound the permission check so a slow or unreachable Canopy cannot hold a request open.

  `CanopyGuard` evaluated with the client-wide defaults — a 30s per-attempt timeout and 2 retries — so a hung call could hold an inbound request for roughly 90s plus backoff, on the authorization path of every guarded route.

  The guard now evaluates with a 5s per-attempt deadline (`evaluateTimeoutMs`) and 1 retry (`evaluateMaxRetries`), both configurable and both scoped to the guard — everything else through the injected client keeps the client-wide values. It also caps each wait between attempts at one deadline, because that wait is otherwise set by Canopy's `Retry-After` header and sits outside the deadline entirely: a `Retry-After: 120` on a 429 would have held the inbound request for two minutes regardless of any timeout configured here.

  Worst case is now roughly `evaluateTimeoutMs × (2 × evaluateMaxRetries + 1)` — about 15s with the defaults, against unbounded before.

  ```ts
  CanopyModule.forRoot({
    apiKey: process.env.CANOPY_API_KEY,
    evaluateTimeoutMs: 2_000,
    evaluateMaxRetries: 0,
    resolveIdentity: (request) => request.user.sub,
  });
  ```

  **A failed check now reports what actually failed.** Every Canopy error became `503 Service Unavailable`, so a rejected or unscoped API key — a permanent misconfiguration — was reported as a temporary outage, inviting retries that could never succeed and hiding the bug. Now: an unreachable, rate-limited or `5xx` Canopy is `503`; a rejected API key or a refused question is `500`; an identity Canopy has never heard of is `403`. Every branch still fails closed.

  **A resolver that throws now denies instead of crashing.** `resolveIdentity: (request) => request.user.sub` — the shape the docs suggested — throws on an unauthenticated request, which surfaced as a `500` rather than the documented `403`. Both resolvers are now called defensively: a throw is treated as "could not resolve", the same denial as returning nothing. The documented examples use `request.user?.sub`.

  **Registering the guard globally is documented properly.** Nest runs global guards before controller- and route-scoped ones, so a globally-registered `CanopyGuard` runs before route-level authentication has populated the request and every guarded route denies. The README now says to register your authentication guard globally ahead of it, or to apply both at the route.

  The guard also aborts the check when the caller disconnects while it is in flight, and propagates that abort rather than reporting `503` — a caller hanging up is not Canopy being unavailable, and it is no longer logged as though it were. Disconnect is detected on the response, on a close arriving before anything was written.

  This is resolved per adapter: Express hands back the Node response directly, Fastify hands back a `Reply` whose real response is on `.raw`. A transport with neither, such as GraphQL, runs to the deadline as before. Both adapters are covered by end-to-end tests that boot a real Nest application and hang up a real client mid-check.

- Updated dependencies [89f0a46]
- Updated dependencies [89f0a46]
- Updated dependencies [41241ca]
  - @canopy-io/node@0.1.1

## 0.1.0

### Minor Changes

- 481ee14: Add `@canopy-io/nestjs`, the NestJS integration.

  `CanopyModule.forRoot` registers one configured client and the guard that uses
  it; `@RequirePermission("orders.refund")` on a route turns into a single
  evaluation against Canopy. The `node` scope is the default, so a permission is
  checked at the node the request touches and inherited from ancestors;
  `app_wide` is opt-in because it answers a coarser question and must not guard a
  node-owned resource.

  The guard fails closed. An unresolvable identity, a node check with no node, a
  denial, or an unreachable API all end the request, and an unreachable API is a
  503 rather than a 403 so "we could not decide" is never reported as "you are
  not allowed".
