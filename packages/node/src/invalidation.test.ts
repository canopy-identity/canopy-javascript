import { describe, expect, expectTypeOf, it } from "vitest";

import type { components } from "./generated/types.js";
import { type AuthorizationChange, invalidationFor } from "./invalidation.js";
import type { WebhookDelivery } from "./webhooks.js";

/** A change as the API sends it, with only what the mapping reads. */
function change(
  event: string,
  metadata: Record<string, unknown> = {},
  resource: { type?: string; id?: string } = {},
): AuthorizationChange {
  return {
    event,
    data: {
      resource_type: resource.type ?? null,
      resource_id: resource.id ?? null,
      metadata,
    },
  };
}

describe("invalidationFor", () => {
  it("takes a webhook delivery and a change-feed entry alike", () => {
    expectTypeOf<WebhookDelivery>().toMatchTypeOf<AuthorizationChange>();
    expectTypeOf<
      components["schemas"]["ChangeEventDto"]
    >().toMatchTypeOf<AuthorizationChange>();
  });

  it.each([
    "assignment.created",
    "assignment.updated",
    "assignment.removed",
    "assignment.activated",
    "assignment.expired",
  ])("drops the person %s names", (event) => {
    expect(
      invalidationFor(
        change(event, { identity_id: "id-1", oauth_client_id: null }),
      ),
    ).toEqual([{ principalType: "identity", id: "id-1" }]);
  });

  it("drops a machine client under its client_id, not its row id", () => {
    expect(
      invalidationFor(
        change("assignment.removed", {
          identity_id: null,
          oauth_client_id: "row-1",
          client_id: "cnpy_client_1",
        }),
      ),
    ).toEqual([{ principalType: "service", id: "cnpy_client_1" }]);
  });

  it("drops each holder a bulk change lists, once each", () => {
    expect(
      invalidationFor(
        change("assignment.bulk_removed", {
          affected: [
            { identity_id: "id-1", node_id: "n1", role_id: "r1" },
            { identity_id: "id-1", node_id: "n2", role_id: "r1" },
            { identity_id: "id-2", node_id: "n1", role_id: "r1" },
          ],
        }),
      ),
    ).toEqual([
      { principalType: "identity", id: "id-1" },
      { principalType: "identity", id: "id-2" },
    ]);
  });

  it("drops everything for a bulk change whose holders it cannot name", () => {
    expect(
      invalidationFor(change("assignment.bulk_created", { succeeded: 3 })),
    ).toBe("all");
    expect(invalidationFor(change("assignment.bulk_removed", {}))).toBe("all");
  });

  it.each([
    "identity.status_set",
    "identity.erased",
    "identity.env_membership.added",
    "identity.env_membership.removed",
    "scim.user.deprovisioned",
    "scim.user.reactivated",
  ])("drops the identity %s is about", (event) => {
    expect(
      invalidationFor(change(event, {}, { type: "identity", id: "id-1" })),
    ).toEqual([{ principalType: "identity", id: "id-1" }]);
  });

  it.each([
    "organization.member.added",
    "organization.member.role_changed",
    "organization.member.removed",
    "scim.group.member_added",
    "scim.group.member_removed",
  ])("drops the member %s names", (event) => {
    expect(
      invalidationFor(
        change(
          event,
          { identity_id: "id-1" },
          { type: "organization", id: "org-1" },
        ),
      ),
    ).toEqual([{ principalType: "identity", id: "id-1" }]);
  });

  it("drops a machine client disabled or deleted", () => {
    expect(
      invalidationFor(
        change("oauth_client.updated", {
          client_id: "cnpy_client_1",
          is_active: false,
        }),
      ),
    ).toEqual([{ principalType: "service", id: "cnpy_client_1" }]);
  });

  it("drops the person a deny names, and everything for a deny on a role or a client", () => {
    expect(
      invalidationFor(
        change("deny.created", {
          target_type: "identity",
          identity_id: "id-1",
        }),
      ),
    ).toEqual([{ principalType: "identity", id: "id-1" }]);
    expect(
      invalidationFor(
        change("deny.deleted", { target_type: "role", role_id: "r1" }),
      ),
    ).toBe("all");
    expect(
      invalidationFor(
        change("deny.created", {
          target_type: "oauth_client",
          oauth_client_id: "row-1",
        }),
      ),
    ).toBe("all");
  });

  it.each([
    "role.created",
    "role.updated",
    "role.deleted",
    "role.permissions.updated",
    "permission.created",
    "permission.updated",
    "permission.deleted",
    "node.created",
    "node.updated",
    "node.deleted",
    "node.moved",
    "hierarchy_schema.updated",
    "organization.created",
    "organization.deleted",
    "organization.deleted_all",
    "scim.group.mapped",
    "scim.group.unmapped",
    "scim.group.updated",
    "scim.group.deleted",
  ])("drops everything for %s", (event) => {
    expect(invalidationFor(change(event))).toBe("all");
  });

  it.each([
    "identity.created",
    "identity.updated",
    "account_member.added",
    "session.all_revoked",
    "oauth_client.secret_rotated",
    "organization.updated",
    "organization.policy.updated",
    "scim.group.created",
  ])("drops nothing for %s", (event) => {
    expect(invalidationFor(change(event))).toBe("none");
  });

  it("drops everything for an event it does not know", () => {
    expect(invalidationFor(change("something.new"))).toBe("all");
  });

  it("drops everything when an event that should name someone does not", () => {
    expect(invalidationFor(change("assignment.removed", {}))).toBe("all");
    expect(invalidationFor(change("identity.status_set"))).toBe("all");
  });
});
