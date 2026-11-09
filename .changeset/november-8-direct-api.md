---
"@canopy-io/node": patch
"@canopy-io/browser": patch
---

Follows Canopy's November 8 release. Canopy now sends an error `code` on every error, so an authorizer pointed at a Canopy that does not serve an endpoint it reads (`request.not_found`) reports the misconfiguration again instead of denying; `code` is null only for a response that did not come from Canopy's API. The generated types add `invited_by_identity_id` on organization invites and `previous_role_id`, `previous_node_id` and `organization_id` on `assignment.updated`, and bulk rows' `error.code` is a string. `@canopy-io/browser` exports types for the `<canopy-captcha>` element. No caller changes are needed.
