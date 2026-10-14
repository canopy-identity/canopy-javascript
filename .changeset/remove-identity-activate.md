---
"@canopy-io/node": minor
---

**Breaking:** `identities.deactivate()` and `identities.activate()` are removed, because the API no longer offers them to Environment-scoped keys. An identity's active flag is Account-wide, so a key for one Environment could lock a person out of every other one. To cut an identity off from this key's Environment, use `identities.delete()`, which removes it from this Environment only. Deactivating an identity everywhere is done in the Admin Workspace or through directory sync.

`identities.update()` no longer accepts `is_active`, for the same reason.

`identities.create()` now documents that `role_id` and `node_id` go together; the API answers 400 when only one is sent, where it used to create the identity with no assignment.

Identity invite responses no longer declare `environment_id` and `environment_name`, which the API never returned on an Environment-scoped key. Listing invites accepts `sort_by` (`name`, `email` or `created`) with `order`, which the API now honours.

An organization's SSO binding (`organizations.ssoConnections`) now carries `owner_organization_node_id` on its `sso_connection`, naming the organization when its administrator set the connection up from the organization portal. Unbinding such a connection from its organization answers 409 `organization.sso_connection_owned_cannot_unbind`; disable or delete it instead. The connection status enum no longer lists `failed`, which nothing ever set.
