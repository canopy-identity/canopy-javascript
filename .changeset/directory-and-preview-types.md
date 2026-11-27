---
"@canopy-io/node": patch
---

Follows Canopy's release that splits the Console's Authentication page and lets a directory refuse clearing its roles. The generated types add `environment_grantable_roles_set` to an organization's directory (whether the Environment sets a list the organization falls back to; without one, clearing the organization's list while its directory is connected is refused), add `sample` to each branding preview state and `client_id` to the preview, and say that the single-client OAuth routes take the client's `client_id` in their path.
