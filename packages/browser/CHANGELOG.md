# @canopy-io/browser

## 0.2.1

### Patch Changes

- 206547c: Follows Canopy's November 8 release. Canopy now sends an error `code` on every error, so an authorizer pointed at a Canopy that does not serve an endpoint it reads (`request.not_found`) reports the misconfiguration again instead of denying; `code` is null only for a response that did not come from Canopy's API. The generated types add `invited_by_identity_id` on organization invites and `previous_role_id`, `previous_node_id` and `organization_id` on `assignment.updated`, and bulk rows' `error.code` is a string. `@canopy-io/browser` exports types for the `<canopy-captcha>` element. No caller changes are needed.

## 0.2.0

### Minor Changes

- 1326269: `getClaims<TCustom>()` returns `IdTokenClaims & TCustom`, so the Environment's custom claims marked for the ID token read typed. `IdTokenClaims` now names `amr`, `org_scope` and `custom_claims_overflow`, which the ID token carries, and drops `sid`, which it never did.

## 0.1.0

### Minor Changes

- 0a59da5: First release. `createCanopyBrowserClient` signs a single-page app in through Canopy's hosted login as a public OAuth client: PKCE with no secret, tokens kept in memory, a reload resumed with `prompt=none`, refreshes shared so a rotated token is never presented twice, and a sign-out that ends Canopy's session too. Zero runtime dependencies.
