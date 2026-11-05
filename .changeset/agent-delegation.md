---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

A machine client can act for a signed-in person. `exchangeToken` trades the person's access token for a `delegated` one (RFC 8693 token exchange); the verifier accepts the `delegated` type per call with `alsoAllow: ["delegated"]`, holds it to `serviceAudience` and requires its `act.sub`, and `delegation(claims)` reads the person and the client off it. `LocalAuthorizer.evaluate` takes `acting_client_id` and allows only when the identity and the client both hold the permission (`acting_client_not_granted` otherwise). In NestJS, `@AllowDelegatedTokens()` admits the token on a route, and `CanopyGuard` then checks both. The generated types carry `acting_client_id` and `acting_client_allowed` on evaluate. The skill says which credential an agent holds, names three mistakes (a full-access key, an account key it does not need, the person's own token) and shows an agent acting for a person.
