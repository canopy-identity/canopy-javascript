---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

Machine clients. An OAuth client registered with `client_kind: machine` holds roles of its own and obtains tokens for itself with the `client_credentials` grant: `type: "service"`, `sub` and `client_id` set to its `client_id`, `gty: "client_credentials"`, and its organization's claims when it is pinned to one. `TokenVerifier` still accepts identity tokens only by default; `verify(token, { alsoAllow: ["service"] })` admits a service token on that one call, held to the new `serviceAudience` option (the audience your API answers to, which the token's `aud` names); without it a service token answers `token.audience_unverified`. In NestJS, `@AllowServiceTokens()` on a route or controller makes `CanopyTokenGuard` admit it there, and `CanopyGuard` then evaluates the client's own grants, chosen from the verified claims.

`LocalAuthorizer` reads a machine client's grants from `GET /api/v1/oauth-clients/:id/grants` when a check carries `principal_type: "service"`; `grantRoots`, `accessibleNodes`, `permissionsAt`, `permissionsAtMany` and `invalidate` take `{ principalType: "service" }`. A client and an identity are cached apart, and an assignment webhook naming a machine client carries its `client_id` (`data.metadata.client_id`) to invalidate by. The conformance bundle gains the `machine-clients` vector, replayed as service-token checks against each client's own grants.

`orgContext(claims)` returns `{ orgId, orgRoles, orgRoleIds }` and now requires `org_role_ids` beside `org_id` and `org_roles`, paired with the names position for position; a token missing it, or with lists of different lengths, answers `null`. A `CanopyGuard` denial reads "Caller does not hold" in place of "Identity does not hold".

The spec now has 157 operations. Generated types cover machine clients (`client_kind`, `organization_node_id`, `allowed_audiences`), their assignment and grant routes, and roles that belong to one organization.
