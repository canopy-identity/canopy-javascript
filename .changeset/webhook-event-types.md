---
"@canopy-io/node": patch
---

Typed webhook deliveries.

- Canopy now publishes a schema per webhook event, and the types are regenerated from it: 37 `Webhook…Event` schemas on the shared envelope, plus `payload_schema` and `resource_types` on `GET /api/v1/webhooks/event-types`. No operation was added or removed.
- New `WebhookDelivery`, `WebhookEventName`, `WebhookEvent<Name>` and `WebhookEventData<Name>` types, and an `isWebhookEvent(delivery, name)` guard, so a handler reads one event's `metadata` without a cast.
- `metadata` is now always an object on every delivery.
