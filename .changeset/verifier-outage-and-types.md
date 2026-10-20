---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

`TokenVerifier` accepts identity tokens only by default. Tokens Canopy signs for its own administrators (`user`), staff (`platform`) and API key flows (`api_key`) are refused with `token.type_not_allowed` unless named in the new `allowedTypes` option; `CanopyTokenGuard` takes it under `verify.allowedTypes`.

When Canopy cannot be reached as cached signing keys come due for a refresh, the verifier keeps verifying with the keys it holds instead of failing every request until the issuer is back. A token signed by a key the verifier has never seen, during an outage, is reported as `token.jwks_unavailable` (503) rather than `token.key_not_found` (401).

New exports `tokenErrorStatus` and `authorizationErrorStatus` turn a failed verification or authorization check into the HTTP status and message to answer with; the NestJS guards use them. The node README's verification example now names its Environment, and documents the 503 and the per-process reach of `LocalAuthorizer.invalidate()`.
