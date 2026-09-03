---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

Organizations support. Identity tokens minted in an Environment running the
organizations access model carry `org_id` and `org_role`; both are now
declared on `CanopyTokenClaims`, and the new `orgContext(claims)` helper
returns the verified pair (or `null` for a token acting in no organization,
refusing a half-present pair). `@RequirePermission` gains `scope: "org"`: the
guard evaluates at the token's `org_id` node through the existing
`LocalAuthorizer` — an organization is a hierarchy node and a membership is a
role assignment at it — reading the claim off what `CanopyTokenGuard`
attached, overridable with the new `resolveOrg` module option. A caller
acting in no organization is denied without a network call.
