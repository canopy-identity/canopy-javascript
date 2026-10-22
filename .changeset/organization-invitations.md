---
"@canopy-io/node": minor
---

Organization invitations name a place and a window. `organizations.createInvite()` takes an optional `role_id` (none admits a member holding nothing, only at the organization node), a `node_id` for an office or team beneath the organization, and `effective_from` / `effective_to`, copied onto the assignment the invitation grants on acceptance. `organizations.addMember()` takes the same `node_id` and dates. Someone already in the Environment, invited into an organization they don't belong to, receives a request to join (`intent: "grant"`) and accepts it with their own sign-in or password. Invitation responses gain `node_name`, `organization_node_id`, `effective_from`, `effective_to` and `invited_by_identity_id`. Types regenerated from the API spec.
