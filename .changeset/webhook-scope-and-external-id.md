---
"@canopy-io/node": patch
---

Regenerate the request/response types from Canopy's OpenAPI document.
Additive, no existing caller shape changed:

- Organizations carry `external_id` (your own id, unique per Environment)
  on the create, update, list, and detail shapes, and the list accepts
  `external_id` as an exact-match query.
- Webhook event-type entries carry `scope` (`"environment"` or
  `"account"`), and `GET /api/v1/webhooks/event-types` now lists every
  event with the scope that subscribes to it, so an environment API key
  learns which events need an account-scoped subscription.
