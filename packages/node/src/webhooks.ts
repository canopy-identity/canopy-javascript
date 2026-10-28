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

/** The headers a delivery carries, in any of the shapes a server hands them over. */
export type WebhookHeaders =
  Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookSignatureInput {
  /** The request's headers: Node's `req.headers`, a Fetch `Headers`, or a plain record. */
  headers: WebhookHeaders;
  /**
   * The request body exactly as it arrived. Parsing and re-serializing the
   * JSON changes spacing or key order, and the signature no longer matches.
   */
  rawBody: string | Uint8Array;
  /**
   * The subscription's signing secret. Pass the old and the new while you
   * roll a rotated secret out: a delivery signed by either verifies.
   */
  secret: string | readonly string[];
  /**
   * How far `X-Canopy-Timestamp` may be from this machine's clock, in
   * seconds, before the delivery is refused as a replay. Default 300. Each
   * retry is signed again with its own timestamp, so a retried delivery is
   * never refused for its age.
   */
  toleranceSeconds?: number;
  /** The current time in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}

/** The default replay window: five minutes either side of this machine's clock. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** The one signature scheme Canopy sends; a value under any other prefix is ignored. */
const SIGNATURE_PREFIX = "v1,";

/** An HMAC-SHA256 is 32 bytes, 64 hex characters. */
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i;

/**
 * Whether a webhook delivery is Canopy's, unaltered and recent.
 *
 * Canopy signs `{X-Canopy-Webhook-Id}.{X-Canopy-Timestamp}.{raw body}` with
 * HMAC-SHA256 under the subscription's signing secret and sends it in
 * `X-Canopy-Signature` as `v1,<hex>`. For a while after a secret rotation
 * the header carries two values, the new secret's first; the delivery is
 * accepted when any value matches any secret given. The comparison is the
 * Web Crypto HMAC verify, which runs in constant time, so this works in
 * Node, Deno, Bun and edge workers alike.
 *
 * Resolves `false`, never rejects, for a missing header, a timestamp outside
 * the tolerance, or no match, so a handler refuses with one status:
 *
 *   app.post(
 *     "/webhooks/canopy",
 *     express.raw({ type: "application/json" }),
 *     async (req, res) => {
 *       const valid = await verifyWebhookSignature({
 *         headers: req.headers,
 *         rawBody: req.body,
 *         secret: process.env.CANOPY_WEBHOOK_SECRET,
 *       });
 *
 *       if (!valid) {
 *         return res.sendStatus(401);
 *       }
 *
 *       const delivery = JSON.parse(req.body.toString()) as WebhookDelivery;
 *       // …
 *     },
 *   );
 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<boolean> {
  const id = header(input.headers, "x-canopy-webhook-id");
  const timestamp = header(input.headers, "x-canopy-timestamp");
  const signature = header(input.headers, "x-canopy-signature");

  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false;
  }

  const tolerance =
    input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);

  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return false;
  }

  const secrets = (
    typeof input.secret === "string" ? [input.secret] : input.secret
  ).filter((secret) => typeof secret === "string" && secret.length > 0);
  const received = signature
    .split(/\s+/)
    .filter((value) => value.startsWith(SIGNATURE_PREFIX))
    .map((value) => value.slice(SIGNATURE_PREFIX.length))
    .filter((hex) => SIGNATURE_HEX.test(hex))
    .map(hexToBytes);

  if (secrets.length === 0 || received.length === 0) {
    return false;
  }

  const encoder = new TextEncoder();
  const body =
    typeof input.rawBody === "string"
      ? encoder.encode(input.rawBody)
      : input.rawBody;
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(new ArrayBuffer(prefix.length + body.length));

  signed.set(prefix, 0);
  signed.set(body, prefix.length);

  // Every secret against every value, without stopping at the first match,
  // so the time taken says nothing about which one matched.
  const checks = await Promise.all(
    secrets.flatMap((secret) => {
      const key = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      return received.map(async (value) =>
        crypto.subtle.verify("HMAC", await key, value, signed),
      );
    }),
  );

  return checks.some(Boolean);
}

/** One header's value, whatever shape the headers came in. */
function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];

  return Array.isArray(value) ? value.join(" ") : value;
}

/** Hex → bytes, without assuming Buffer (this runs in workers too). */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}
