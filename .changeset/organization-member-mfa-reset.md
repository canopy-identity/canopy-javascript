---
"@canopy-io/node": patch
---

`organizations.resetMemberMfa(id, identityId)` clears a member's second factor (factors, recovery codes and remembered devices) so they enrol again at their next sign-in.

Types regenerated from the live spec: the organization's SSO connection can be created without `default_role_id` and reports it as nullable, `GET /api/v1/organizations/:id/sso-connection/arrival-roles` lists the roles its sign-ins may arrive with (`is_default`, `administers_organization`), and the directory detail carries `grantable_roles_source` (`organization`, `environment` or `none`). The arrival-roles route is reachable through `canopy.client.request`, like the rest of that connection's routes.
