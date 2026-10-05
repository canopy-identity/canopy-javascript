---
"@canopy-io/node": minor
---

Types regenerated from the live spec, which now declares every response each endpoint gives.

One caller shape changed: `scopes` on API key creation narrows from any string to the 13 scopes the platform offers (`hierarchy.view`, `hierarchy.manage`, `rbac.view_roles`, `rbac.manage_roles`, `rbac.view_assignments`, `rbac.manage_assignments`, `permissions.evaluate`, `identity.view`, `identity.manage`, `api_key.view`, `api_key.manage`, `webhook.view`, `webhook.manage`). The API already refuses any other value with `400`, so code that compiled against the old type and passed an unknown scope was failing at runtime; it now fails at compile time instead.

Everything else is additive. `operations` and `paths` now type the error responses each endpoint can return (`400`, `403`, `404`, `409`, `429`) with Canopy's error envelope, where before most declared only their success. The API's public operation count stays at 138.
