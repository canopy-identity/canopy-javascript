import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  verifyWebhookSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "./webhooks.js";

/**
 * Signed the way the API's delivery service signs: HMAC-SHA256 over
 * `{id}.{timestamp}.{body}`, sent as `v1,<hex>`, one value per secret in
 * force, the current secret's first.
 */

const ID = "9b3e1f70-4c1a-4c55-9c3e-0d7b2e1f9a10";
const NOW_SECONDS = 1_730_822_400;
const BODY = '{"event":"assignment.removed","data":{"metadata":{}}}';
const SECRET = "whsec_current";
const PREVIOUS = "whsec_previous";

function sign(secret: string, body = BODY, timestamp = NOW_SECONDS): string {
  return `v1,${createHmac("sha256", secret)
    .update(`${ID}.${timestamp}.${body}`)
    .digest("hex")}`;
}

function headers(signature: string, timestamp = NOW_SECONDS) {
  return {
    "x-canopy-webhook-id": ID,
    "x-canopy-timestamp": String(timestamp),
    "x-canopy-signature": signature,
    "x-canopy-event": "assignment.removed",
  };
}

const now = () => NOW_SECONDS * 1000;

describe("verifyWebhookSignature", () => {
  it("accepts a delivery signed with the secret", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers(sign(SECRET)),
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(valid).toBe(true);
  });

  it("accepts the raw body as bytes", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers(sign(SECRET)),
      rawBody: Buffer.from(BODY, "utf8"),
      secret: SECRET,
      now,
    });

    expect(valid).toBe(true);
  });

  it("reads Fetch headers, whatever their case", async () => {
    const fetchHeaders = new Headers({
      "X-Canopy-Webhook-Id": ID,
      "X-Canopy-Timestamp": String(NOW_SECONDS),
      "X-Canopy-Signature": sign(SECRET),
    });

    const valid = await verifyWebhookSignature({
      headers: fetchHeaders,
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(valid).toBe(true);
  });

  it("accepts either value while a rotation's window is open", async () => {
    const both = `${sign(SECRET)} ${sign(PREVIOUS)}`;

    const withNew = await verifyWebhookSignature({
      headers: headers(both),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    const withOld = await verifyWebhookSignature({
      headers: headers(both),
      rawBody: BODY,
      secret: PREVIOUS,
      now,
    });

    expect(withNew).toBe(true);
    expect(withOld).toBe(true);
  });

  it("accepts any of the secrets a receiver holds while it rolls one out", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers(sign(PREVIOUS)),
      rawBody: BODY,
      secret: [SECRET, PREVIOUS],
      now,
    });

    expect(valid).toBe(true);
  });

  it("refuses a body changed after signing", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers(sign(SECRET)),
      rawBody: BODY.replace("removed", "created"),
      secret: SECRET,
      now,
    });

    expect(valid).toBe(false);
  });

  it("refuses a delivery signed with another secret", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers(sign("whsec_someone_else")),
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(valid).toBe(false);
  });

  it("refuses a signature replayed under another id", async () => {
    const valid = await verifyWebhookSignature({
      headers: { ...headers(sign(SECRET)), "x-canopy-webhook-id": "other" },
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(valid).toBe(false);
  });

  it("refuses a timestamp outside the tolerance, either side", async () => {
    const stale = NOW_SECONDS - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1;
    const future = NOW_SECONDS + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1;

    const old = await verifyWebhookSignature({
      headers: headers(sign(SECRET, BODY, stale), stale),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    const ahead = await verifyWebhookSignature({
      headers: headers(sign(SECRET, BODY, future), future),
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(old).toBe(false);
    expect(ahead).toBe(false);
  });

  it("takes a wider tolerance when asked", async () => {
    const stale = NOW_SECONDS - 600;

    const valid = await verifyWebhookSignature({
      headers: headers(sign(SECRET, BODY, stale), stale),
      rawBody: BODY,
      secret: SECRET,
      toleranceSeconds: 900,
      now,
    });

    expect(valid).toBe(true);
  });

  it("refuses a missing header, a scheme it does not know, and an empty secret", async () => {
    const unsigned = await verifyWebhookSignature({
      headers: { "x-canopy-webhook-id": ID, "x-canopy-timestamp": "1" },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    const otherScheme = await verifyWebhookSignature({
      headers: headers(sign(SECRET).replace("v1,", "v2,")),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    const noSecret = await verifyWebhookSignature({
      headers: headers(sign("")),
      rawBody: BODY,
      secret: "",
      now,
    });

    expect(unsigned).toBe(false);
    expect(otherScheme).toBe(false);
    expect(noSecret).toBe(false);
  });

  it("refuses a malformed signature value rather than throwing", async () => {
    const valid = await verifyWebhookSignature({
      headers: headers("v1,not-hex v1,abc"),
      rawBody: BODY,
      secret: SECRET,
      now,
    });

    expect(valid).toBe(false);
  });
});
