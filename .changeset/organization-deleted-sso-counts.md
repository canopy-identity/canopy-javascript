---
"@canopy-io/node": patch
---

`organization.deleted` and `organization.deleted_all` webhook deliveries now type `domains_released`, `sso_bindings_removed` and `sso_connections_removed`: deleting an organization releases its email-domain claims, its SSO binding and any connection it owned.
