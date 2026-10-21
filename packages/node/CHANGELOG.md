# @canopy-io/node

## 0.11.0

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

## 0.10.0

### Minor Changes

- f2ee649: `LocalAuthorizer` is held to Canopy's own authorization rules. Its suite replays the conformance vectors Canopy publishes at `/conformance/authorization.json`, the same cases Canopy's API suite replays end to end, and `npm run generate` keeps the copy in step with the published one.
  
  The grant roots (`GET /api/v1/identities/:id/grants`) and the hierarchy's parent edges (`GET /api/v1/nodes/parents`) now carry the `model_version` of the authorization model they describe. `LocalAuthorizer` refuses a version it does not know with `CanopyAuthorizerError` (`authorizer.model_version_unknown`), which `authorizationErrorStatus` and the NestJS guard answer as a `500` misconfiguration, rather than walking rows whose meaning has changed. It knows version 1. This release requires a Canopy that sends `model_version`; against one that does not, every check is refused, so upgrade after the API has it.
  
  `@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.

## 0.9.0

### Minor Changes

- 436d639: Follows Canopy's paged hierarchy, grant, session and directory group reads. These endpoints now answer `{ items, pagination }`, at most 100 to a page, where they used to answer the whole collection.
  
  `LocalAuthorizer`, and so `CanopyGuard`, reads every page of an identity's grant roots (now one row per permission and node) and every page of the hierarchy's parent edges, 100 at a time. Revalidation still costs one request: only the hierarchy's first page is sent with its `ETag`, and a `304` keeps the held copy. When the hierarchy has changed, every page is read again, and a rebuild over several pages is confirmed against the first page's `ETag` so a change made mid-read is not kept half-applied. `snapshot()` gains `grantPages` and `treePages`, the page requests behind `grantFetches` and `treeRequests`. Earlier versions deny every check against a Canopy that answers grants as one row per node, so upgrade before that API reaches you.
  
  Caller shapes that changed:
  
  - `identities.sessions(id, query?)` returns a `Paginator` instead of a promise of `{ items }`, and takes `page` and `take`. Use `for await`, `.all()` or `.first()`.
  - `organizations.listDirectoryGroups(id, query?)` returns a `Paginator`, and takes `page`, `take`, `q` (display name or external id) and `sort_by` (`name`, the default, or `created`). The item type is exported as `OrganizationDirectoryGroupItem`.
  - `permissions.evaluateBulk` takes between 1 and 100 checks; more is refused with a `400`.
  - The generated types follow the API: `GET /api/v1/nodes` and `GET /api/v1/nodes/:id/tree` answer pages of flat nodes (`ScopedNodeResponseDto`, linked by `parent_node_id`) instead of a nested tree with its scope, `GET /api/v1/nodes/:id/children` is paged, and `IdentityGrantResponseDto` carries `node_id` instead of `nodes`. Several lists' `sort_by` is now typed to the columns each accepts.
  
  `@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.

## 0.8.0

### Minor Changes

- 621b9a6: `TokenVerifier` accepts identity tokens only by default. Tokens Canopy signs for its own administrators (`user`), staff (`platform`) and API key flows (`api_key`) are refused with `token.type_not_allowed` unless named in the new `allowedTypes` option; `CanopyTokenGuard` takes it under `verify.allowedTypes`.
  
  When Canopy cannot be reached as cached signing keys come due for a refresh, the verifier keeps verifying with the keys it holds instead of failing every request until the issuer is back. A token signed by a key the verifier has never seen, during an outage, is reported as `token.jwks_unavailable` (503) rather than `token.key_not_found` (401).
  
  New exports `tokenErrorStatus` and `authorizationErrorStatus` turn a failed verification or authorization check into the HTTP status and message to answer with; the NestJS guards use them. The node README's verification example now names its Environment, and documents the 503 and the per-process reach of `LocalAuthorizer.invalidate()`.

## 0.7.2

### Patch Changes

- 66415c2: The NestJS README's first `CanopyModule.forRoot` example now includes the required `verify` option, and `@canopy-io/node`'s types are regenerated from the published spec, adding the `branding.view` and `branding.manage` API key scopes. No behaviour changes.

## 0.7.1

### Patch Changes

- 221e502: `LocalAuthorizer` keeps its copy of the hierarchy in about 40% less memory: one id string per node instead of two. A parsed `GET /api/v1/nodes/parents` response holds each node id twice, as the node's own `id` and again in its children's `parent_node_id`, and the cache used to keep both copies. A 50,000-node hierarchy now costs about 4.6 MB rather than 7.4 MB. Answers are unchanged.

## 0.7.0

### Minor Changes

- b336767: **Breaking:** the authorizer's cache window is capped at five minutes. `LocalAuthorizer`'s `ttlMs` (and `CanopyModule`'s `authorizationTtlMs`) above `300_000`, below `0`, or not a number now throws a `RangeError` when the authorizer is created. The window is how long a revoked user keeps access, so a longer one is refused rather than honoured. The default (60 seconds) and `0` (read fresh on every check) are unchanged. `MAX_TTL_MS` is exported.
- b336767: **Breaking:** `TokenVerifier` no longer defaults its issuer. Every Canopy Environment is its own issuer with its own signing keys (`https://auth.canopy-io.com/environments/<id>`), so the old default, the bare hosted origin, rejected every identity token. Pass `environmentId`, or `issuer` on a custom auth domain or self-hosted instance; the constructor throws with neither or both. The key set is read from the issuer's own `/.well-known/jwks.json`.

  `CanopyModule` now requires `verify` with `environmentId` (or `issuer`), since it builds the verifier at startup.

  The generated types follow the published API, which now includes OAuth client management (`/api/v1/oauth-clients`); those routes are typed but not wrapped as a resource, like API key management.

## 0.6.0

### Minor Changes

- 30b76ce: **Breaking:** `identities.deactivate()` and `identities.activate()` are removed, because the API no longer offers them to Environment-scoped keys. An identity's active flag is Account-wide, so a key for one Environment could lock a person out of every other one. To cut an identity off from this key's Environment, use `identities.delete()`, which removes it from this Environment only. Deactivating an identity everywhere is done in the Admin Workspace or through directory sync.

  `identities.update()` no longer accepts `is_active`, for the same reason.

  `identities.create()` now documents that `role_id` and `node_id` go together; the API answers 400 when only one is sent, where it used to create the identity with no assignment.

  Identity invite responses no longer declare `environment_id` and `environment_name`, which the API never returned on an Environment-scoped key. Listing invites accepts `sort_by` (`name`, `email` or `created`) with `order`, which the API now honours.

  An organization's SSO binding (`organizations.ssoConnections`) now carries `owner_organization_node_id` on its `sso_connection`, naming the organization when its administrator set the connection up from the organization portal. Unbinding such a connection from its organization answers 409 `organization.sso_connection_owned_cannot_unbind`; disable or delete it instead. The connection status enum no longer lists `failed`, which nothing ever set.

- 30b76ce: SSO connection responses no longer carry `last_login_failure_at`, `consecutive_failures` or `auto_disabled_at`. Nothing ever set them, so they only ever returned their defaults; a connection is disabled only by a person. `last_login_at` stays and now records each successful sign-in through the connection.

### Patch Changes

- 30b76ce: Types regenerated from the spec, with no shape change: the descriptions now say that a deactivated role grants nothing to its holders (`is_active`, the explain trace's `active`), and that an empty `allowed_children` list makes a node type a leaf.

  `Authorizer.invalidate()` documents deactivating or reactivating a role as a change to clear the whole cache for, since it changes access for everyone holding the role at once.

  The identity invite create and resend descriptions say a `password_reset` invite expires after 24 hours; every other invite still expires after 7 days.

## 0.5.0

### Minor Changes

- 0444343: Types regenerated from the spec, which adds five branding fields and makes one existing field nullable.

  One caller shape changed: `product_name` on the effective branding (`GET /api/v1/branding`, `effective`) is now `string | null`. When the customer sets no product name, the hosted pages show none instead of Canopy's, and the response says so with `null`. Code that read it as always a string should handle the absent case.

  Everything else is additive. The stored branding, the effective branding and the update body gain `logo_kind` (`full` or `icon`), `favicon_url`, `background_color`, `terms_url` and `privacy_url`. The API's public operation count stays at 138.

## 0.4.0

### Minor Changes

- e9a9d26: Types regenerated from the live spec, which now declares every response each endpoint gives.

  One caller shape changed: `scopes` on API key creation narrows from any string to the 13 scopes the platform offers (`hierarchy.view`, `hierarchy.manage`, `rbac.view_roles`, `rbac.manage_roles`, `rbac.view_assignments`, `rbac.manage_assignments`, `permissions.evaluate`, `identity.view`, `identity.manage`, `api_key.view`, `api_key.manage`, `webhook.view`, `webhook.manage`). The API already refuses any other value with `400`, so code that compiled against the old type and passed an unknown scope was failing at runtime; it now fails at compile time instead.

  Everything else is additive. `operations` and `paths` now type the error responses each endpoint can return (`400`, `403`, `404`, `409`, `429`) with Canopy's error envelope, where before most declared only their success. The API's public operation count stays at 138.

## 0.3.12

### Patch Changes

- 7acdc44: Read and revoke an identity's sessions from your backend. `identities.sessions(id)` lists every live session the identity holds, newest first, with when and where it was signed in, when it expires and the organization it acts in, so you can confirm a sign-out from your own side. `identities.revokeSession(id, sessionId)` ends one of them and leaves the rest signed in, and `identities.revokeSessions(id)` ends them all. `IdentitySessionItem` types one session.

  The generated types also pick up what the API added alongside: an SSO test sign-in result names the `missing_fields`, the `received_attributes`, the SAML `name_id_format` and a `hint` at the fix; a webhook subscription reports `previous_secret_expires_at` while a rotated-out secret still verifies; and the `organization.created` event carries `source: "self_signup"` when the Environment created the organization for a person who registered. No existing caller shape changed. The API's public operation count moves from 136 to 138.

## 0.3.11

### Patch Changes

- 4b08934: Organization policy types regenerated from the live spec. `updatePolicy` accepts `allowed_sign_in_methods`, a non-empty subset of the methods the Environment offers (`password`, `email_otp`, `sso`) or `null` to inherit them all; a method the Environment has off is refused with `organization.policy_loosens`. `getPolicy` returns the field on the organization's own values, on `environment` (what is offered) and on `effective` (what members may use, `["sso"]` alone while `require_sso` is on).

## 0.3.10

### Patch Changes

- b71e786: Webhook types regenerated from the live spec. Deliveries for a change directory sync made (`identity.created`, `identity.env_membership.*`, `organization.member.*`, `assignment.bulk_*`) now type `source: "scim"` and `directory_id`, and the directory's own activity is subscribable: `scim.user.provisioned` / `updated` / `deprovisioned` / `reactivated`, `scim.group.created` / `updated` / `deleted` / `member_added` / `member_removed` / `mapped` / `unmapped`. `identity.created` also types `source: "sso_jit"` with `connection_id` for an identity a first SSO sign-in created.

## 0.3.9

### Patch Changes

- dc7525d: `organizations.setDirectoryGrantableRoles` with an empty list now returns the organization to the Environment's list when one is set, under a connected directory too. It is refused only when there is no Environment list to fall back on. Types regenerated from the live spec; no signatures change.

## 0.3.8

### Patch Changes

- a96ec16: `organizations.resetMemberMfa(id, identityId)` clears a member's second factor (factors, recovery codes and remembered devices) so they enrol again at their next sign-in.

  Types regenerated from the live spec: the organization's SSO connection can be created without `default_role_id` and reports it as nullable, `GET /api/v1/organizations/:id/sso-connection/arrival-roles` lists the roles its sign-ins may arrive with (`is_default`, `administers_organization`), and the directory detail carries `grantable_roles_source` (`organization`, `environment` or `none`). The arrival-roles route is reachable through `canopy.client.request`, like the rest of that connection's routes.

## 0.3.7

### Patch Changes

- 703377c: `organization.deleted` and `organization.deleted_all` webhook deliveries now type `domains_released`, `sso_bindings_removed` and `sso_connections_removed`: deleting an organization releases its email-domain claims, its SSO binding and any connection it owned.

## 0.3.6

### Patch Changes

- 0708712: Typed webhook deliveries.

  - Canopy now publishes a schema per webhook event, and the types are regenerated from it: 37 `Webhook…Event` schemas on the shared envelope, plus `payload_schema` and `resource_types` on `GET /api/v1/webhooks/event-types`. No operation was added or removed.
  - New `WebhookDelivery`, `WebhookEventName`, `WebhookEvent<Name>` and `WebhookEventData<Name>` types, and an `isWebhookEvent(delivery, name)` guard, so a handler reads one event's `metadata` without a cast.
  - `metadata` is now always an object on every delivery.

## 0.3.5

### Patch Changes

- bd5a478: Set up an organization's directory sync (SCIM) from your backend.

  - `organizations.setDirectoryGrantableRoles` and `listDirectoryGrantableRoles` wrap the two new operations, `PUT`/`GET /api/v1/organizations/{id}/directory/grantable-roles`. Naming the roles an organization's identity provider may grant, and the one people arrive with, is what opens directory sync for it. Only your API key can set the list; an organization admin's token can read it and is refused changing it.
  - The rest of an organization's directory is wrapped too: `getDirectory`, `createDirectory`, `removeDirectory`, `listDirectoryTokens`, `mintDirectoryToken`, `rotateDirectoryToken`, `revokeDirectoryToken`, `listDirectoryActivity`, `listDirectoryGroups`, `mapDirectoryGroup` and `unmapDirectoryGroup`. They were already typed and reachable through `client.request`.
  - `base_url` on a directory and on a minted token is now the full URL, including the host, so it can be handed to a customer as it is. If you were putting your API host in front of it, stop.

  The published spec gained 2 operations (132 to 134), both additive, so this is a patch.

## 0.3.4

### Patch Changes

- faefa0a: Type the organization sign-in surface: SSO connection, domains, recovery codes
  and directory sync.

  The API has let a backend configure an organization's own sign-in since
  2026-09-18, and nothing in this package said so. A consumer checking the SDK —
  or the coding agent working for them — found no such operations and concluded
  Canopy could not do it. The published spec now carries 132 operations (was
  102), all additive: no operation was removed or renamed, and no existing
  request or response shape lost a field.

  Newly typed, under `/api/v1/organizations/{id}`:

  - **SSO connection** — create, read, update, remove, import SAML metadata,
    activate, disable, service-provider details, recent sign-ins.
  - **Domains** — list, claim (returns the TXT challenge), verify, remove.
    Routing and just-in-time provisioning read only verified domains.
  - **SSO recovery codes** — regenerate. Turning `require_sso` on through
    `updatePolicy` issues the first batch.
  - **Test sign-in** — start, and read the outcome.
  - **Directory sync** — create, read, remove; mint, rotate and revoke SCIM
    tokens; activity; groups and their role mappings; the roles a directory may
    grant.
  - **Roles** — the roles assignable in the organization.

  Plus Environment branding (read and update).

  These are typed and callable today through `canopy.client.request` with
  `RequestBody<…>` / `ResponseBody<…>`; resource methods for them are not in this
  release. No caller changes are needed to take it.

## 0.3.3

### Patch Changes

- b6b1dd0: Ship the changelog with the package, and create a GitHub Release per published
  version.

  The changelog was written on every release and reachable by nobody: `files`
  omitted it, so npm showed none, and the release workflow pushed tags without
  creating releases, so the Releases page sat empty. A consumer deciding whether
  to take a bump had nothing to read. `CHANGELOG.md` is now in the tarball, each
  README links it and notes that a pre-1.0 minor may break, and the workflow
  opens a release whose body is that version's changelog section.

## 0.3.2

### Patch Changes

- 7e71cc7: Regenerate the request/response types from Canopy's OpenAPI document.
  Additive, no existing caller shape changed:

  - MFA factor entries carry `webauthn_rp_id`: for a passkey, the relying-party
    id it was created under and the only domain it answers on (the
    Environment's own `webauthn_rp_id`, or Canopy's when the Environment names
    none). `null` for every other factor type.

## 0.3.1

### Patch Changes

- 5b06ccf: Regenerate the request/response types from Canopy's OpenAPI document.
  Additive, no existing caller shape changed:

  - Organizations carry `external_id` (your own id, unique per Environment)
    on the create, update, list, and detail shapes, and the list accepts
    `external_id` as an exact-match query.
  - Webhook event-type entries carry `scope` (`"environment"` or
    `"account"`), and `GET /api/v1/webhooks/event-types` now lists every
    event with the scope that subscribes to it, so an environment API key
    learns which events need an account-scoped subscription.

## 0.3.0

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
- e4ca3ef: Organizations as a container: `canopy.organizations` wraps the tenant API
  (organizations, members, invitations, the per-organization sign-in policy,
  and SSO connection binding), `CanopyTokenClaims` declares `amr`, types are
  regenerated against the current spec, and the wording no longer describes
  organizations as an access model. The published spec now carries 102 operations (was 84), all additive.

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
