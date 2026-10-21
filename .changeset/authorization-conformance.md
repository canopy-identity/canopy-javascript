---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

`LocalAuthorizer` is held to Canopy's own authorization rules. Its suite replays the conformance vectors Canopy publishes at `/conformance/authorization.json`, the same cases Canopy's API suite replays end to end, and `npm run generate` keeps the copy in step with the published one.

The grant roots (`GET /api/v1/identities/:id/grants`) and the hierarchy's parent edges (`GET /api/v1/nodes/parents`) now carry the `model_version` of the authorization model they describe. `LocalAuthorizer` refuses a version it does not know with `CanopyAuthorizerError` (`authorizer.model_version_unknown`), which `authorizationErrorStatus` and the NestJS guard answer as a `500` misconfiguration, rather than walking rows whose meaning has changed. It knows version 1. This release requires a Canopy that sends `model_version`; against one that does not, every check is refused, so upgrade after the API has it.

`@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.
