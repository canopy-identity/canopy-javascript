# @canopy-io/browser

## 0.4.0

### Minor Changes

- a5b221a: Ready for a framework layer, with a permission client. `start()` takes `{ url, resume }`: a silent resume comes back to the page it left (`returnTo` is the path, query and hash), calls share one run so a framework that runs its effects twice exchanges the code once and never redirects, and `resume: false` finishes a sign-in without sending a public page's visitor to Canopy. `subscribe(listener)` and `getSnapshot()` (`status`, `claims`, `error`) report the session as a stable object replaced only when it changes, for `useSyncExternalStore` and Angular signals. The constructor reads no browser global, so the client can be built during server rendering. `getAccessTokenClaims()` reads the access token's claims (`permissions`, `org_id`, `org_roles`, `org_permissions`, custom claims) for display and gating. `checkPermission(permission, { nodeId })`, `checkPermissions(checks)`, `getPermissionState()` and `listPermissions()` answer what the signed-in person may do: from the token when it can say (an Environment-wide check from `permissions`, a check at the session's organization from `org_permissions`), else from `POST /v1/identity/auth/me/permissions/evaluate`, with the checks of one tick in one request and every answer held until the token is refreshed, the organization changes or the person signs out. `CanopyAuthError` gains `retryAfterSeconds`. Breaking: `start(url)` is now `start({ url })`.

## 0.3.0

### Minor Changes

- a7d473f: Follows Canopy's hosted page languages and safe retries release.
  
  - `@canopy-io/node`: the generated types add `locale` to identities and invitations, `default_language` and `available_languages` to the sign-in settings, the branding `languages`, `default_language`, `page_template` and `page_template_sources`, and the `409` and `503` `Idempotency-Key` answers. A call declared `idempotent` is now also retried on `409 idempotency.request_in_progress`, the answer Canopy gives while an earlier attempt with the same `Idempotency-Key` is still running; `idempotency.outcome_unknown` is never retried.
  - `@canopy-io/browser`: `signIn({ uiLocales })` names the language the hosted pages are shown in, sent as `ui_locales`.
  
  The agent skill says how an application names the hosted pages' language, and how to make a create safe to retry with an `Idempotency-Key`.

## 0.2.1

### Patch Changes

- 206547c: Follows Canopy's November 8 release. Canopy now sends an error `code` on every error, so an authorizer pointed at a Canopy that does not serve an endpoint it reads (`request.not_found`) reports the misconfiguration again instead of denying; `code` is null only for a response that did not come from Canopy's API. The generated types add `invited_by_identity_id` on organization invites and `previous_role_id`, `previous_node_id` and `organization_id` on `assignment.updated`, and bulk rows' `error.code` is a string. `@canopy-io/browser` exports types for the `<canopy-captcha>` element. No caller changes are needed.

## 0.2.0

### Minor Changes

- 1326269: `getClaims<TCustom>()` returns `IdTokenClaims & TCustom`, so the Environment's custom claims marked for the ID token read typed. `IdTokenClaims` now names `amr`, `org_scope` and `custom_claims_overflow`, which the ID token carries, and drops `sid`, which it never did.

## 0.1.0

### Minor Changes

- 0a59da5: First release. `createCanopyBrowserClient` signs a single-page app in through Canopy's hosted login as a public OAuth client: PKCE with no secret, tokens kept in memory, a reload resumed with `prompt=none`, refreshes shared so a rotated token is never presented twice, and a sign-out that ends Canopy's session too. Zero runtime dependencies.
