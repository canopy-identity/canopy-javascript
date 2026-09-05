# @canopy-io/node

## 0.2.0

### Minor Changes

- 13ecf63: `LocalAuthorizer.invalidate(identityId?)` — with an identity id, only that
  identity's cached grants are dropped; the hierarchy and every other identity
  stay warm. This is the shape an assignment webhook wants: invalidate exactly
  the identity the event names. With no argument the behaviour is unchanged
  (drop everything). The jsdoc now also states the multi-instance guarantee
  honestly: an invalidation reaches one process, so behind a load balancer the
  fleet-wide revocation guarantee remains the TTL.

### Patch Changes

- b873daa: Fix type resolution for CommonJS consumers on `node16`/`nodenext`: the
  `exports` map now declares per-condition `types`, pointing `require` at the
  `index.d.cts` the build already emitted. Previously a `require()` that worked
  at runtime was rejected by TypeScript (TS1479), forcing dynamic-import and
  `resolution-mode` workarounds. Verified with `arethetypeswrong` across
  node10, node16-CJS, node16-ESM and bundler resolution.
- 003761a: Regenerate the request/response types from the published OpenAPI document.
  Additive: picks up the permission-usage endpoint
  (`GET /api/v1/permissions/{id}/usage`) and refreshed operation descriptions.
  No existing caller shape changed.

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

- 41241ca: Cancellation, per-request headers, per-call deadlines, and two correctness fixes on the authorization path.

  **Behavior change — `identities.assignments` is paginated.** It now returns a `Paginator` rather than a single response, and accepts query parameters. The endpoint is paginated at 20 per page; the previous signature returned only the first page while documenting itself as "every role this identity holds", so an identity with more than 20 assignments was silently under-reported — the dangerous direction to be wrong in on an authorization surface.

  ```ts
  // before — first page only
  const { items } = await canopy.identities.assignments(id);

  // after — every page
  const all = await canopy.identities.assignments(id).all();
  for await (const assignment of canopy.identities.assignments(id)) {
  }
  ```

  **The permission evaluations now retry a 5xx.** `evaluate`, `evaluateBulk` and `explain` are POSTs only because the question travels in a body — they compute a decision and write nothing. They were subject to the client's POST-is-not-idempotent rule, which made the hot path the least resilient call in the SDK. They are now marked idempotent; endpoints that create are unchanged and still never retried.

  **Behavior change — caller cancellation.** Aborting the `AbortSignal` passed to a request now propagates as an abort (`AbortError`, or whatever `signal.reason` holds) and is never retried. Previously a caller's abort was wrapped as `CanopyConnectionError` and, on an idempotent request, retried — re-issuing a request the caller had already cancelled. An already-aborted signal now short-circuits before `fetch` is called at all, and an abort during retry backoff stops there.

  Timeouts and transport failures are unchanged: they still throw `CanopyConnectionError` and are still retried where the method allows it.

  If you branch on `isCanopyConnectionError` to handle cancellation, match on the abort instead:

  ```ts
  catch (error) {
    if ((error as Error).name === "AbortError") {
      // the caller cancelled
    }
  }
  ```

  **Per-request headers.** `RequestOptions.headers` sets headers for a single call, so the protocol headers the API documents are now reachable: `If-Match` for optimistic concurrency, and `Idempotency-Key` for safe bulk retries. Per-request headers override the client-wide `headers`; the credential is applied last and cannot be replaced by a call site.

  The four wrapped operations whose spec declares `If-Match` take it directly:

  ```ts
  await canopy.roles.update(id, { name: "Editor" }, { ifMatch: role.version });
  await canopy.roles.delete(id, { ifMatch: role.version });
  await canopy.permissions.update(
    id,
    { name: "Read" },
    { ifMatch: permission.version },
  );
  await canopy.permissions.delete(id, { ifMatch: permission.version });
  ```

  **Backoff between retries is now bounded.** `Retry-After` was honoured verbatim, so a `Retry-After: 120` on a 429 blocked the caller for two minutes — outside `timeoutMs`, which only ever bounded a single attempt. The advised delay is now clamped to `maxBackoffMs`, a new client and per-call option defaulting to 30s. A caller's abort is also observed _during_ the wait rather than after it, so cancelling no longer means cancelling once the backoff elapses.

  **Per-call deadlines and retry caps.** `RequestOptions.timeoutMs` and `RequestOptions.maxRetries` override the client-wide values for a single call, and `permissions.evaluate`, `evaluateBulk` and `explain` now accept `CallOptions` (`signal`, `timeoutMs`, `maxRetries`, `headers`). Both were previously constructor-only, so a latency-critical call on the request path had to accept deadlines sized for administrative CRUD. They are worth setting together: a deadline alone still permits `maxRetries + 1` attempts back to back.

  **Fixed.** A 2xx response whose body is not JSON — a gateway answering in place of the API — now throws `CanopyError` carrying the status, instead of a `SyntaxError` surfacing as a misleading "connection failed".

  `CanopyError.retryAfterMs` is now a declared, typed field. It was previously attached at runtime and invisible to TypeScript.

## 0.1.0

### Minor Changes

- 8e2b399: Add the `Canopy` facade with `permissions`, `identities`, `roles` and `assignments` resources. Every request and response type is derived from the published OpenAPI document rather than hand-written.
- f1a510e: Add the client core: authentication, response-envelope unwrapping, typed errors, and a retry policy that will not repeat a non-idempotent request.
- 345dae8: Add `paginate` — one iterator that walks both offset and cursor pagination, inferring the style from the server's response.
- e21f27f: Add a spec-drift guard that fails when the API's operation surface changes, and relax `roles.list()` and `permissions.list()` to take no arguments now that the published spec no longer marks their filters required.
