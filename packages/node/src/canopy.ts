import { CanopyClient, type CanopyClientOptions } from "./client.js";
import { Assignments } from "./resources/assignments.js";
import { Identities } from "./resources/identities.js";
import { Permissions } from "./resources/permissions.js";
import { Roles } from "./resources/roles.js";

/**
 * The entry point most callers want.
 *
 * ```ts
 * const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
 *
 * const { allowed } = await canopy.permissions.evaluate({
 *   identity_id: identityId,
 *   permission: "documents.read",
 *   scope: "node",
 *   node_id: nodeId,
 * });
 * ```
 *
 * `client` is public because the wrapped resources cover the paths integrators
 * hit most, not all 81 operations. Anything not wrapped is still reachable —
 * `canopy.client.request("GET", "/api/v1/audit-events")` — with the same
 * envelope handling, typed errors and retry policy, so no endpoint is a dead
 * end while the ergonomic surface catches up.
 */
export class Canopy {
  readonly client: CanopyClient;
  readonly permissions: Permissions;
  readonly identities: Identities;
  readonly roles: Roles;
  readonly assignments: Assignments;

  constructor(options: CanopyClientOptions) {
    this.client = new CanopyClient(options);
    this.permissions = new Permissions(this.client);
    this.identities = new Identities(this.client);
    this.roles = new Roles(this.client);
    this.assignments = new Assignments(this.client);
  }
}
