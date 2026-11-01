---
"@canopy-io/node": minor
---

`CANOPY_BASE_URL` sets the Canopy origin for the whole process: `Canopy` and `CanopyClient` call it instead of the hosted API, and `TokenVerifier` resolves `environmentId` to an issuer under it. A self-hosted instance, a proxy or a test stack sets the one variable and keeps the code it would write for hosted Canopy. An explicit `baseUrl` or `issuer` still wins. Read through `globalThis`, so browsers, Workers and Deno are unaffected.
