---
"@canopy-io/node": minor
---

Types regenerated from the spec, which adds five branding fields and makes one existing field nullable.

One caller shape changed: `product_name` on the effective branding (`GET /api/v1/branding`, `effective`) is now `string | null`. When the customer sets no product name, the hosted pages show none instead of Canopy's, and the response says so with `null`. Code that read it as always a string should handle the absent case.

Everything else is additive. The stored branding, the effective branding and the update body gain `logo_kind` (`full` or `icon`), `favicon_url`, `background_color`, `terms_url` and `privacy_url`. The API's public operation count stays at 138.
