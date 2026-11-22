---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

`LocalAuthorizer` revalidates a subject's grants instead of re-reading them. A refresh sends the `ETag` the held grants came with as `If-None-Match`, and Canopy answers an unchanged subject with `304` after reading only its access versions, so the grants stay in memory and only their expiry moves. Changed grants are read in full, as before. The cache time and what it promises are unchanged: a change still takes effect within `ttlMs`, and a grant still starts or ends at its window's edge. `snapshot()` adds `grantNotModified`. The generated types follow Canopy's current spec, which adds the grants `304` and two branding operations (`ApiBrandingController_uploadImage`, `ApiBrandingController_previewLink`), not wrapped yet. No caller changes are needed.
