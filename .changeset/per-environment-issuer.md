---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

**Breaking:** `TokenVerifier` no longer defaults its issuer. Every Canopy Environment is its own issuer with its own signing keys (`https://auth.canopy-io.com/environments/<id>`), so the old default, the bare hosted origin, rejected every identity token. Pass `environmentId`, or `issuer` on a custom auth domain or self-hosted instance; the constructor throws with neither or both. The key set is read from the issuer's own `/.well-known/jwks.json`.

`CanopyModule` now requires `verify` with `environmentId` (or `issuer`), since it builds the verifier at startup.
