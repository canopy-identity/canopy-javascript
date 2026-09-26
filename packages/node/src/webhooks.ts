import type { components } from "./generated/types.js";

/**
 * Typed webhook deliveries.
 *
 * Canopy publishes one schema per webhook event, named `Webhook…Event`, each
 * the shared envelope narrowed to that event's name, `resource_type` and
 * `metadata`. These types read them straight out of the generated document,
 * so a handler is written against the contract rather than against
 * deliveries it happened to capture, and `npm run generate` brings in any
 * field the API adds.
 *
 *   app.post("/webhooks/canopy", (req, res) => {
 *     const delivery = req.body as WebhookDelivery;
 *
 *     if (isWebhookEvent(delivery, "organization.member.added")) {
 *       delivery.data.metadata.identity_id; // string
 *     }
 *   });
 *
 * `GET /api/v1/webhooks/event-types` names each event's schema in
 * `payload_schema`, which is the name to look up in `Schema<…>`.
 */

/** The name of every published delivery schema. */
type WebhookSchemaName = Extract<
  keyof components["schemas"],
  `Webhook${string}Event`
>;

/** A delivery of any webhook event: `{ event, data }`. */
export type WebhookDelivery = components["schemas"][WebhookSchemaName];

/** Every event a subscription can receive. */
export type WebhookEventName = WebhookDelivery["event"];

/**
 * The delivery of one event, e.g. `WebhookEvent<"assignment.created">`.
 * Its `data.metadata` carries exactly the fields that event sends, with the
 * ones every delivery includes required and the rest optional.
 */
export type WebhookEvent<Name extends WebhookEventName> = Extract<
  WebhookDelivery,
  { event: Name }
>;

/** The `data` object of one event's delivery. */
export type WebhookEventData<Name extends WebhookEventName> =
  WebhookEvent<Name>["data"];

/**
 * Narrow a delivery to one event by its name. A type guard rather than a
 * switch over `delivery.event`, so a handler for one event reads that
 * event's `metadata` without a cast.
 */
export function isWebhookEvent<Name extends WebhookEventName>(
  delivery: WebhookDelivery,
  name: Name,
): delivery is WebhookEvent<Name> {
  return delivery.event === name;
}
