# @canopy-io/browser

## 0.2.0

### Minor Changes

- 1326269: `getClaims<TCustom>()` returns `IdTokenClaims & TCustom`, so the Environment's custom claims marked for the ID token read typed. `IdTokenClaims` now names `amr`, `org_scope` and `custom_claims_overflow`, which the ID token carries, and drops `sid`, which it never did.

## 0.1.0

### Minor Changes

- 0a59da5: First release. `createCanopyBrowserClient` signs a single-page app in through Canopy's hosted login as a public OAuth client: PKCE with no secret, tokens kept in memory, a reload resumed with `prompt=none`, refreshes shared so a rotated token is never presented twice, and a sign-out that ends Canopy's session too. Zero runtime dependencies.
