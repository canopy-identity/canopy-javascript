---
"@canopy-io/node": minor
---

OAuth client types now carry public clients: `client_type` (`confidential` or `public`) and `token_endpoint_auth_method` (`client_secret_basic` or `none`) on every client, `client_type` on create, and `client_secret` in the create response is `string | null`, null for a public client, which has none. Code that reads `client_secret` from a create response now has to handle null. Rotating a public client's secret answers `409 oauth.client_public_has_no_secret`.
