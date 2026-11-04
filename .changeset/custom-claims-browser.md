---
"@canopy-io/browser": minor
---

`getClaims<TCustom>()` returns `IdTokenClaims & TCustom`, so the Environment's custom claims marked for the ID token read typed. `IdTokenClaims` now names `amr`, `org_scope` and `custom_claims_overflow`, which the ID token carries, and drops `sid`, which it never did.
