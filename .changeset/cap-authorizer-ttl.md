---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

**Breaking:** the authorizer's cache window is capped at five minutes. `LocalAuthorizer`'s `ttlMs` (and `CanopyModule`'s `authorizationTtlMs`) above `300_000`, below `0`, or not a number now throws a `RangeError` when the authorizer is created. The window is how long a revoked user keeps access, so a longer one is refused rather than honoured. The default (60 seconds) and `0` (read fresh on every check) are unchanged. `MAX_TTL_MS` is exported.
