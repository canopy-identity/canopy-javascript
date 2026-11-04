# @canopy-io/browser

## 0.1.0

### Minor Changes

- 0a59da5: First release. `createCanopyBrowserClient` signs a single-page app in through Canopy's hosted login as a public OAuth client: PKCE with no secret, tokens kept in memory, a reload resumed with `prompt=none`, refreshes shared so a rotated token is never presented twice, and a sign-out that ends Canopy's session too. Zero runtime dependencies.
