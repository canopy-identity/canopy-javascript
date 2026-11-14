---
"@canopy-io/node": minor
---

Follows Canopy's hosted page customization release. The generated types add the new branding fields (the color scheme and dark look, text and card colors, layout, background and side panel, corner radius, card style and shadow, heading and body fonts, reworded texts, and the header, notice and footer content) and four branding routes: `GET /api/v1/branding/fonts`, `GET /api/v1/branding/text-keys`, `GET /api/v1/branding/preview-pages` and `POST /api/v1/branding/preview`. A web OAuth client's `branding` carries its own look over its Environment's. The agent skill shows how to read the fonts and texts, preview, and then save. The operation count moves from 299 to 303. No caller changes are needed.
