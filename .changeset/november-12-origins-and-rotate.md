---
"@canopy-io/node": patch
---

Follows Canopy's November 12 release. The generated types add `POST /api/v1/scim-tokens/{id}/rotate`, which replaces a directory token and keeps the old one working for seven days, and carry the fields and error codes earlier releases added. The agent skill teaches that allowed web origins are each Environment's own list: a browser app's site listed only on another Environment is refused with `403 auth.origin_not_allowed` on the Direct API, and a public client's token request with `403 access_denied` (`@canopy-io/browser` raises `CanopyAuthError` with that code). No caller changes are needed.
