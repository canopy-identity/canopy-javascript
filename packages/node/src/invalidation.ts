import type { PrincipalType } from "./authorizer.js";

/**
 * Which of a {@link LocalAuthorizer}'s cached answers a change makes stale.
 *
 * A webhook delivery and a change-feed entry share one shape, `{ event, data }`,
 * so both are read here. The rule is the narrowest invalidation that is still
 * correct: a change that names whose access moved drops those subjects' grants
 * and nothing else; a change whose reach the event cannot name (a role's
 * permissions, the hierarchy, a deny on every holder of a role) drops
 * everything; a change that moves no one's access drops nothing.
 *
 * An event this SDK does not know drops everything. A newer Canopy can send
 * events an older SDK has never seen, and guessing that one is harmless would
 * be the unsafe direction: a cache cleared for nothing costs one read per
 * subject, a cache kept past a revocation costs a wrong allow.
 */

/** A change as it arrives: a webhook delivery or a change-feed entry. */
export interface AuthorizationChange {
  event: string;
  data: {
    resource_type?: string | null;
    resource_id?: string | null;
    metadata?: Record<string, unknown> | null;
  };
}

/** A principal whose cached grants a change dropped. */
export interface InvalidatedSubject {
  principalType: PrincipalType;
  id: string;
}

/** What applying one change did to the cache. */
export type AppliedChange =
  | { event: string; invalidated: "none" }
  | { event: string; invalidated: "subjects"; subjects: InvalidatedSubject[] }
  | { event: string; invalidated: "all" };

/** Changes that move no one's access: profile edits, sessions, sign-in policy. */
const NO_ACCESS_CHANGE = new Set([
  "identity.created",
  "identity.updated",
  "account_member.added",
  "account_member.removed",
  "session.all_revoked",
  "oauth_client.secret_rotated",
  "organization.updated",
  "organization.policy.updated",
  "organization.sso_connection.bound",
  "organization.sso_connection.unbound",
  // A pushed group grants nothing until it is mapped, which is its own event.
  "scim.group.created",
]);

/**
 * Changes whose subject is the identity the event is about: its status, its
 * Environment membership, a directory provisioning or deprovisioning it.
 */
const IDENTITY_RESOURCE = new Set([
  "identity.status_set",
  "identity.erased",
  "identity.env_membership.added",
  "identity.env_membership.removed",
  "scim.user.provisioned",
  "scim.user.updated",
  "scim.user.deprovisioned",
  "scim.user.reactivated",
]);

/** One assignment, held by a person (`identity_id`) or a machine client (`client_id`). */
const ONE_ASSIGNMENT = new Set([
  "assignment.created",
  "assignment.updated",
  "assignment.removed",
  "assignment.activated",
  "assignment.expired",
]);

/** Several assignments, each holder listed in `metadata.affected`. */
const AFFECTED_ASSIGNMENTS = new Set([
  "assignment.bulk_removed",
  "assignment.bulk_role_changed",
]);

/** Membership changes naming the person in `metadata.identity_id`. */
const IDENTITY_IN_METADATA = new Set([
  "organization.member.added",
  "organization.member.role_changed",
  "organization.member.removed",
  "scim.group.member_added",
  "scim.group.member_removed",
]);

/** A machine client disabled, re-enabled or deleted, named by its `client_id`. */
const MACHINE_CLIENT = new Set([
  "oauth_client.updated",
  "oauth_client.deleted",
]);

/** Every change to a single assignment or deny names its holder this way. */
function holderOf(
  metadata: Record<string, unknown>,
): InvalidatedSubject | undefined {
  const identityId = text(metadata["identity_id"]);

  if (identityId) {
    return { principalType: "identity", id: identityId };
  }

  // A machine client is cached under its `client_id`, the id its grants
  // route takes, not under the client's row id.
  const clientId = text(metadata["client_id"]);

  if (clientId) {
    return { principalType: "service", id: clientId };
  }

  return undefined;
}

/** The subjects one change names, or `"all"` when it cannot name them. */
export function invalidationFor(
  change: AuthorizationChange,
): InvalidatedSubject[] | "all" | "none" {
  const { event, data } = change;
  const metadata = data.metadata ?? {};

  if (NO_ACCESS_CHANGE.has(event)) {
    return "none";
  }

  if (IDENTITY_RESOURCE.has(event)) {
    const id = data.resource_type === "identity" ? text(data.resource_id) : "";

    return id ? [{ principalType: "identity", id }] : "all";
  }

  if (ONE_ASSIGNMENT.has(event)) {
    const holder = holderOf(metadata);

    return holder ? [holder] : "all";
  }

  if (AFFECTED_ASSIGNMENTS.has(event)) {
    const affected = Array.isArray(metadata["affected"])
      ? (metadata["affected"] as unknown[])
      : [];
    const holders = affected.map((entry) =>
      entry !== null && typeof entry === "object"
        ? holderOf(entry as Record<string, unknown>)
        : undefined,
    );

    // One holder the event fails to name means its reach is not known.
    if (holders.length === 0 || holders.some((holder) => !holder)) {
      return "all";
    }

    return unique(holders as InvalidatedSubject[]);
  }

  if (IDENTITY_IN_METADATA.has(event)) {
    const id = text(metadata["identity_id"]);

    return id ? [{ principalType: "identity", id }] : "all";
  }

  if (MACHINE_CLIENT.has(event)) {
    const clientId = text(metadata["client_id"]);

    return clientId ? [{ principalType: "service", id: clientId }] : "all";
  }

  // A deny on one person names them. A deny on a machine client names the
  // client's row id, not the `client_id` it is cached under, and a deny on
  // a role binds everyone holding it, so both drop everything.
  if (event === "deny.created" || event === "deny.deleted") {
    const id =
      metadata["target_type"] === "identity"
        ? text(metadata["identity_id"])
        : "";

    return id ? [{ principalType: "identity", id }] : "all";
  }

  // Roles, permissions, nodes, the hierarchy schema, organizations created
  // or deleted, bulk-created assignments (the event lists no holders), a
  // directory group mapped, unmapped, changed or deleted, and every event
  // this SDK does not know.
  return "all";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function unique(subjects: InvalidatedSubject[]): InvalidatedSubject[] {
  const seen = new Map<string, InvalidatedSubject>();

  for (const subject of subjects) {
    seen.set(`${subject.principalType}:${subject.id}`, subject);
  }

  return [...seen.values()];
}
