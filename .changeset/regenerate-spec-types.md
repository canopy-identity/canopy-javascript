---
"@canopy-io/node": patch
---

Regenerate the request/response types from the published OpenAPI document.
Additive: picks up the permission-usage endpoint
(`GET /api/v1/permissions/{id}/usage`) and refreshed operation descriptions.
No existing caller shape changed.
