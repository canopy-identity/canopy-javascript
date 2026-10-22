# @canopy-io/nestjs

## 0.6.0

### Minor Changes

- 10d3583: Organization membership is admission, not a role. Identity tokens carry `org_roles` (the names of the roles held at the organization node, sorted, possibly empty) in place of `org_role`; `orgContext(claims)` returns `{ orgId, orgRoles }`, and refuses a token carrying one claim without the other. An empty `orgRoles` is a member holding no role at the organization node, so authorize by evaluating rather than by the list. The conformance bundle gains the `organization-membership` vector: a grant inside an organization counts only while the membership is active, which the grants `LocalAuthorizer` caches already reflect.
  
  `organizations.changeMemberRole()` is gone with its route: a member's role at the organization is an assignment at the organization node, written through `assignments.create()`, `assignments.update()` and `assignments.delete()` with the organization node as `node_id`. `assignments.update()` takes `{ ifMatch }` and sends it as `If-Match`; a stale version answers `409 assignment.version_mismatch`. `organizations.removeMember()` deactivates the membership and revokes every role the member held in the organization. Member rows carry `status`, `source`, `joined_at` and `roles[]` in place of the single `role`.

### Patch Changes

- Updated dependencies [10d3583]
  - @canopy-io/node@0.12.0

## 0.5.0

### Minor Changes

- 6cbddf8: `LocalAuthorizer` answers the list question, says why a check was denied, and hears every verdict.
  
  - `grantRoots(identityId, permission)`: the nodes the permission is granted at, in effect now, minus the ones another root already covers, with `envWide` when one is the Environment's root.
  - `accessibleNodes(identityId, permission, { maxNodes })`: those roots expanded through their descendants into a `Set` for an `IN (...)` filter, from the same cached tree a check walks. Capped at `maxNodes` (10,000 by default, settable per authorizer or per call); past the cap `nodes` is null and `complete` false, and the roots filter a closure table or materialised path instead.
  - `permissionsAt(identityId, nodeId)`: every permission the identity holds at the node, by grant or inheritance; `permissionsAtMany(identityId, nodeIds)` answers several nodes from one read.
  - `evaluate` returns `{ allowed, reason }`. On a denial `reason` is `permission_not_held`, `outside_grants`, `expired`, `not_yet_effective` or `node_missing`. The grant roots are read with `include=windows`, so a grant that ends before the TTL is re-read at its boundary.
  - `onDecision` and `onDenied` options, fired after every verdict and never awaited; a hook that throws is ignored.
  - `canopy.identities.accessibleNodes(id, { permission, max_nodes })` wraps `GET /api/v1/identities/:id/accessible-nodes`, and `canopy.identities.permissions(id, { node_id })` takes the node.
  
  This version reads `GET /api/v1/identities/:id/grants?include=windows`, which Canopy serves from the same release that adds the accessible-nodes endpoint; against an older API the read is refused and every check fails, so upgrade after the API has it.
  
  `@canopy-io/nestjs` accepts `onDecision` and `onDenied` in `CanopyModuleOptions` and passes them to the authorizer; the guard's own behaviour is unchanged.

### Patch Changes

- Updated dependencies [6cbddf8]
  - @canopy-io/node@0.11.0

## 0.4.2

### Patch Changes

- f2ee649: `LocalAuthorizer` is held to Canopy's own authorization rules. Its suite replays the conformance vectors Canopy publishes at `/conformance/authorization.json`, the same cases Canopy's API suite replays end to end, and `npm run generate` keeps the copy in step with the published one.
  
  The grant roots (`GET /api/v1/identities/:id/grants`) and the hierarchy's parent edges (`GET /api/v1/nodes/parents`) now carry the `model_version` of the authorization model they describe. `LocalAuthorizer` refuses a version it does not know with `CanopyAuthorizerError` (`authorizer.model_version_unknown`), which `authorizationErrorStatus` and the NestJS guard answer as a `500` misconfiguration, rather than walking rows whose meaning has changed. It knows version 1. This release requires a Canopy that sends `model_version`; against one that does not, every check is refused, so upgrade after the API has it.
  
  `@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.
- Updated dependencies [f2ee649]
  - @canopy-io/node@0.10.0

## 0.4.1

### Patch Changes

- 436d639: Follows Canopy's paged hierarchy, grant, session and directory group reads. These endpoints now answer `{ items, pagination }`, at most 100 to a page, where they used to answer the whole collection.
  
  `LocalAuthorizer`, and so `CanopyGuard`, reads every page of an identity's grant roots (now one row per permission and node) and every page of the hierarchy's parent edges, 100 at a time. Revalidation still costs one request: only the hierarchy's first page is sent with its `ETag`, and a `304` keeps the held copy. When the hierarchy has changed, every page is read again, and a rebuild over several pages is confirmed against the first page's `ETag` so a change made mid-read is not kept half-applied. `snapshot()` gains `grantPages` and `treePages`, the page requests behind `grantFetches` and `treeRequests`. Earlier versions deny every check against a Canopy that answers grants as one row per node, so upgrade before that API reaches you.
  
  Caller shapes that changed:
  
  - `identities.sessions(id, query?)` returns a `Paginator` instead of a promise of `{ items }`, and takes `page` and `take`. Use `for await`, `.all()` or `.first()`.
  - `organizations.listDirectoryGroups(id, query?)` returns a `Paginator`, and takes `page`, `take`, `q` (display name or external id) and `sort_by` (`name`, the default, or `created`). The item type is exported as `OrganizationDirectoryGroupItem`.
  - `permissions.evaluateBulk` takes between 1 and 100 checks; more is refused with a `400`.
  - The generated types follow the API: `GET /api/v1/nodes` and `GET /api/v1/nodes/:id/tree` answer pages of flat nodes (`ScopedNodeResponseDto`, linked by `parent_node_id`) instead of a nested tree with its scope, `GET /api/v1/nodes/:id/children` is paged, and `IdentityGrantResponseDto` carries `node_id` instead of `nodes`. Several lists' `sort_by` is now typed to the columns each accepts.
  
  `@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.
- Updated dependencies [436d639]
  - @canopy-io/node@0.9.0

## 0.4.0

### Minor Changes

- 621b9a6: `TokenVerifier` accepts identity tokens only by default. Tokens Canopy signs for its own administrators (`user`), staff (`platform`) and API key flows (`api_key`) are refused with `token.type_not_allowed` unless named in the new `allowedTypes` option; `CanopyTokenGuard` takes it under `verify.allowedTypes`.
  
  When Canopy cannot be reached as cached signing keys come due for a refresh, the verifier keeps verifying with the keys it holds instead of failing every request until the issuer is back. A token signed by a key the verifier has never seen, during an outage, is reported as `token.jwks_unavailable` (503) rather than `token.key_not_found` (401).
  
  New exports `tokenErrorStatus` and `authorizationErrorStatus` turn a failed verification or authorization check into the HTTP status and message to answer with; the NestJS guards use them. The node README's verification example now names its Environment, and documents the 503 and the per-process reach of `LocalAuthorizer.invalidate()`.

### Patch Changes

- Updated dependencies [621b9a6]
  - @canopy-io/node@0.8.0

## 0.3.1

### Patch Changes

- 66415c2: The NestJS README's first `CanopyModule.forRoot` example now includes the required `verify` option, and `@canopy-io/node`'s types are regenerated from the published spec, adding the `branding.view` and `branding.manage` API key scopes. No behaviour changes.
- Updated dependencies [66415c2]
  - @canopy-io/node@0.7.2

## 0.3.0

### Minor Changes

- b336767: **Breaking:** the authorizer's cache window is capped at five minutes. `LocalAuthorizer`'s `ttlMs` (and `CanopyModule`'s `authorizationTtlMs`) above `300_000`, below `0`, or not a number now throws a `RangeError` when the authorizer is created. The window is how long a revoked user keeps access, so a longer one is refused rather than honoured. The default (60 seconds) and `0` (read fresh on every check) are unchanged. `MAX_TTL_MS` is exported.
- b336767: **Breaking:** `TokenVerifier` no longer defaults its issuer. Every Canopy Environment is its own issuer with its own signing keys (`https://auth.canopy-io.com/environments/<id>`), so the old default, the bare hosted origin, rejected every identity token. Pass `environmentId`, or `issuer` on a custom auth domain or self-hosted instance; the constructor throws with neither or both. The key set is read from the issuer's own `/.well-known/jwks.json`.

  `CanopyModule` now requires `verify` with `environmentId` (or `issuer`), since it builds the verifier at startup.

  The generated types follow the published API, which now includes OAuth client management (`/api/v1/oauth-clients`); those routes are typed but not wrapped as a resource, like API key management.

### Patch Changes

- Updated dependencies [b336767]
- Updated dependencies [b336767]
  - @canopy-io/node@0.7.0

## 0.2.4

### Patch Changes

- Updated dependencies [30b76ce]
- Updated dependencies [30b76ce]
- Updated dependencies [30b76ce]
  - @canopy-io/node@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [0444343]
  - @canopy-io/node@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [e9a9d26]
  - @canopy-io/node@0.4.0

## 0.2.1

### Patch Changes

- b6b1dd0: Ship the changelog with the package, and create a GitHub Release per published
  version.

  The changelog was written on every release and reachable by nobody: `files`
  omitted it, so npm showed none, and the release workflow pushed tags without
  creating releases, so the Releases page sat empty. A consumer deciding whether
  to take a bump had nothing to read. `CHANGELOG.md` is now in the tarball, each
  README links it and notes that a pre-1.0 minor may break, and the workflow
  opens a release whose body is that version's changelog section.

- Updated dependencies [b6b1dd0]
  - @canopy-io/node@0.3.3

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
