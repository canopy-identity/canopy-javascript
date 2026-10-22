---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

Organization membership is admission, not a role. Identity tokens carry `org_roles` (the names of the roles held at the organization node, sorted, possibly empty) in place of `org_role`; `orgContext(claims)` returns `{ orgId, orgRoles }`, and refuses a token carrying one claim without the other. An empty `orgRoles` is a member holding no role at the organization node, so authorize by evaluating rather than by the list. The conformance bundle gains the `organization-membership` vector: a grant inside an organization counts only while the membership is active, which the grants `LocalAuthorizer` caches already reflect.

`organizations.changeMemberRole()` is gone with its route: a member's role at the organization is an assignment at the organization node, written through `assignments.create()`, `assignments.update()` and `assignments.delete()` with the organization node as `node_id`. `assignments.update()` takes `{ ifMatch }` and sends it as `If-Match`; a stale version answers `409 assignment.version_mismatch`. `organizations.removeMember()` deactivates the membership and revokes every role the member held in the organization. Member rows carry `status`, `source`, `joined_at` and `roles[]` in place of the single `role`.
