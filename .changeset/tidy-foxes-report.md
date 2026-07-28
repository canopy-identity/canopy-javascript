---
"@canopy-io/sdk": minor
---

Add a spec-drift guard that fails when the API's operation surface changes, and relax `roles.list()` and `permissions.list()` to take no arguments now that the published spec no longer marks their filters required.
