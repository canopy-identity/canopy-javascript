---
"@canopy-io/node": minor
---

Generated types follow the API as Canopy now publishes it. The spec has 199 operations.

- Access previews are stored: the node move and delete, role permission and organization node previews answer an `id` and `expires_at` with their counts and no longer carry `people`. The people are read from `GET /api/v1/access-previews/{previewId}/people`, or as CSV from `.../people.csv`, by the principal that made the preview. Code that read `people` from a preview's type reads the new route instead.
- Identities can be created with a password hash: `password_hash` and `password_hash_algorithm` on create and bulk create. The request schemas are now `ApiCreateIdentityDto` and `ApiBulkCreateIdentitiesDto` in `components["schemas"]`, so a reference to `CreateIdentityDto` or `BulkCreateIdentitiesDto` takes the new name.
