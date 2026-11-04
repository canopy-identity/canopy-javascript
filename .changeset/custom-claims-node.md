---
"@canopy-io/node": minor
---

`TokenVerifier.verify<TCustom>()` returns `CanopyTokenClaims & TCustom`, so an Environment's custom claims (a `plan` mapped from metadata, say) read typed off the verified token: `verify<{ plan?: "free" | "pro" }>(token)`. `custom_claims_overflow` is named on the claims: true when the mapped claims did not all fit, in which case a missing one is unknown rather than unset. The generated types cover `GET` and `PUT /api/v1/token-claims`, the Environment's mapping (`token_claims.view` / `token_claims.manage`).
