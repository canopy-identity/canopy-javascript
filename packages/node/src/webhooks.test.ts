import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isWebhookEvent,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookEventData,
  type WebhookEventName,
} from "./webhooks.js";

/**
 * These pin the contract the types are read from. If the API renames an
 * event or drops a field every delivery carries, the generated document
 * changes and one of these stops compiling, which is the point.
 */

const memberAdded: WebhookEvent<"organization.member.added"> = {
  event: "organization.member.added",
  data: {
    account_id: "acct_1",
    application_id: "app_1",
    environment_id: "env_1",
    actor_id: "key_1",
    actor_type: "api_key",
    resource_type: "organization",
    resource_id: "org_1",
    metadata: { identity_id: "id_1", role_id: "role_1" },
    timestamp: "2026-09-26T00:00:00.000Z",
  },
};

describe("webhook event types", () => {
  it("names every published event", () => {
    expectTypeOf<"organization.member.added">().toMatchTypeOf<WebhookEventName>();
    expectTypeOf<"assignment.updated">().toMatchTypeOf<WebhookEventName>();
    expectTypeOf<"session.all_revoked">().toMatchTypeOf<WebhookEventName>();
    // The directory's own activity, subscribable from this release on.
    expectTypeOf<"scim.group.member_added">().toMatchTypeOf<WebhookEventName>();
    expectTypeOf<"not.an.event">().not.toMatchTypeOf<WebhookEventName>();
  });

  it("marks a change directory sync made", () => {
    type Added = WebhookEventData<"organization.member.added">["metadata"];

    // Set for a member a directory pushed, beside the invite and SSO sources.
    expectTypeOf<Added["source"]>().toEqualTypeOf<
      "sso_jit" | "invite" | "scim" | undefined
    >();
    expectTypeOf<Added["directory_id"]>().toEqualTypeOf<
      string | null | undefined
    >();

    type Joined = WebhookEventData<"scim.group.member_added">["metadata"];

    expectTypeOf<Joined["identity_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Joined["directory_user_id"]>().toEqualTypeOf<string>();
  });

  it("types an event's metadata from its own schema", () => {
    type Added = WebhookEventData<"organization.member.added">["metadata"];

    expectTypeOf<Added["identity_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Added["role_id"]>().toEqualTypeOf<string>();
    // Present only for a just-in-time or invited member, so optional.
    expectTypeOf<Added["invite_id"]>().toEqualTypeOf<string | undefined>();

    // `assignment.updated` carries the node it is held at.
    type Updated = WebhookEventData<"assignment.updated">["metadata"];

    expectTypeOf<Updated["node_id"]>().toEqualTypeOf<string>();

    // Deleting an organization reports what went with it, SSO included.
    type Deleted = WebhookEventData<"organization.deleted">["metadata"];

    expectTypeOf<Deleted["memberships_removed"]>().toEqualTypeOf<number>();
    expectTypeOf<Deleted["domains_released"]>().toEqualTypeOf<number>();
    expectTypeOf<Deleted["sso_bindings_removed"]>().toEqualTypeOf<number>();
    expectTypeOf<Deleted["sso_connections_removed"]>().toEqualTypeOf<number>();
  });

  it("narrows a delivery by name", () => {
    const delivery: WebhookDelivery = memberAdded;

    if (isWebhookEvent(delivery, "organization.member.added")) {
      expectTypeOf(delivery.data.metadata.identity_id).toEqualTypeOf<string>();
      expect(delivery.data.metadata.identity_id).toBe("id_1");
    } else {
      throw new Error("expected the delivery to narrow");
    }

    expect(isWebhookEvent(delivery, "organization.member.removed")).toBe(false);
  });

  it("keeps the envelope on every event", () => {
    expectTypeOf<
      WebhookEvent<"role.created">["data"]["timestamp"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      WebhookEvent<"role.created">["data"]["resource_type"]
    >().toEqualTypeOf<"role">();
  });
});
