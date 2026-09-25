import type { CanopyClient } from "../client.js";
import { paginate, type Paginator } from "../pagination.js";
import { withConcurrency } from "../schema.js";
import type {
  ConcurrencyOptions,
  QueryParams,
  RequestBody,
  ResponseBody,
} from "../schema.js";

/**
 * Tenant organizations: one per business customer, a role per membership,
 * each with its own authentication policy and identity provider. Every
 * call here needs the Environment's organizations container switched on.
 */
export class Organizations {
  constructor(private readonly client: CanopyClient) {}

  list(
    query: QueryParams<"ApiOrganizationsController_listOrganizations"> = {},
  ): Paginator<OrganizationItem> {
    return paginate<OrganizationItem>(
      (params) =>
        this.client.request("GET", "/api/v1/organizations", {
          query: params,
        }),
      { ...query },
    );
  }

  get(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationsController_getOrganization">> {
    return this.client.request("GET", `/api/v1/organizations/${enc(id)}`);
  }

  create(
    input: RequestBody<"ApiOrganizationsController_createOrganization">,
  ): Promise<ResponseBody<"ApiOrganizationsController_createOrganization">> {
    return this.client.request("POST", "/api/v1/organizations", {
      body: input,
    });
  }

  /**
   * Pass `ifMatch` with the organization's current `version` to make a
   * read-modify-write safe — a concurrent edit answers 409 instead of being
   * silently overwritten.
   */
  update(
    id: string,
    input: RequestBody<"ApiOrganizationsController_updateOrganization">,
    options: ConcurrencyOptions = {},
  ): Promise<ResponseBody<"ApiOrganizationsController_updateOrganization">> {
    return this.client.request("PATCH", `/api/v1/organizations/${enc(id)}`, {
      body: input,
      ...withConcurrency(options),
    });
  }

  /**
   * Removes the organization with its memberships, pending invitations,
   * policy, connection bindings, and the tree beneath it. Member identities
   * survive.
   */
  delete(id: string, options: ConcurrencyOptions = {}): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}`,
      withConcurrency(options),
    );
  }

  /** Empties the container: every organization goes, the step before switching it off. */
  deleteAll(): Promise<void> {
    return this.client.request("DELETE", "/api/v1/organizations");
  }

  // ── Members: one role per member, held inside the organization only ──

  listMembers(
    id: string,
    query: QueryParams<"ApiOrganizationsController_listMembers"> = {},
  ): Paginator<OrganizationMemberItem> {
    return paginate<OrganizationMemberItem>(
      (params) =>
        this.client.request("GET", `/api/v1/organizations/${enc(id)}/members`, {
          query: params,
        }),
      { ...query },
    );
  }

  addMember(
    id: string,
    input: RequestBody<"ApiOrganizationsController_addMember">,
  ): Promise<ResponseBody<"ApiOrganizationsController_addMember">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/members`,
      { body: input },
    );
  }

  changeMemberRole(
    id: string,
    identityId: string,
    input: RequestBody<"ApiOrganizationsController_changeMemberRole">,
  ): Promise<ResponseBody<"ApiOrganizationsController_changeMemberRole">> {
    return this.client.request(
      "PATCH",
      `/api/v1/organizations/${enc(id)}/members/${enc(identityId)}`,
      { body: input },
    );
  }

  /** Revokes that organization's one role; the identity and its other memberships are untouched. */
  removeMember(id: string, identityId: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/members/${enc(identityId)}`,
    );
  }

  // ── Invitations: pending membership, carrying the role the recipient will hold ──

  listInvites(
    id: string,
    query: QueryParams<"ApiOrganizationsController_listInvites"> = {},
  ): Paginator<OrganizationInviteItem> {
    return paginate<OrganizationInviteItem>(
      (params) =>
        this.client.request("GET", `/api/v1/organizations/${enc(id)}/invites`, {
          query: params,
        }),
      { ...query },
    );
  }

  createInvite(
    id: string,
    input: RequestBody<"ApiOrganizationsController_createInvite">,
  ): Promise<ResponseBody<"ApiOrganizationsController_createInvite">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/invites`,
      { body: input },
    );
  }

  revokeInvite(id: string, inviteId: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/invites/${enc(inviteId)}`,
    );
  }

  // ── Policy: the organization's tightening of the Environment's sign-in rules ──

  /**
   * The organization's own values (null inherits), the Environment baseline
   * they tighten from, and the effective policy its members sign in under.
   */
  getPolicy(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationsController_getPolicy">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/policy`,
    );
  }

  /**
   * Can only tighten the Environment: a value that would loosen it answers
   * 400 `organization.policy_loosens`. Pass `ifMatch` with the policy's
   * `version` (0 until the organization sets one) for a safe
   * read-modify-write.
   */
  updatePolicy(
    id: string,
    input: RequestBody<"ApiOrganizationsController_updatePolicy">,
    options: ConcurrencyOptions = {},
  ): Promise<ResponseBody<"ApiOrganizationsController_updatePolicy">> {
    return this.client.request(
      "PATCH",
      `/api/v1/organizations/${enc(id)}/policy`,
      { body: input, ...withConcurrency(options) },
    );
  }

  // ── SSO: the organization's own identity provider ──

  listSsoConnections(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationsController_listSsoConnections">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/sso-connections`,
    );
  }

  /**
   * Sign-ins through the connection then land in this organization, joining
   * as a member with `default_role_id`. The connection must already be bound
   * to the organization's Environment, and a connection binds to one
   * organization per Environment.
   */
  bindSsoConnection(
    id: string,
    input: RequestBody<"ApiOrganizationsController_bindSsoConnection">,
  ): Promise<ResponseBody<"ApiOrganizationsController_bindSsoConnection">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/sso-connections`,
      { body: input },
    );
  }

  unbindSsoConnection(id: string, connectionId: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/sso-connections/${enc(connectionId)}`,
    );
  }

  // ── Directory sync: the organization's own SCIM connection ──

  /**
   * The roles this organization's identity provider may grant, and the one
   * people arrive with. An empty list means directory sync is not open for
   * the organization.
   */
  listDirectoryGrantableRoles(
    id: string,
  ): Promise<
    ResponseBody<"ApiOrganizationDirectoryController_listGrantableRoles">
  > {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/directory/grantable-roles`,
    );
  }

  /**
   * Replace the list in one act, which is how directory sync is opened for
   * an organization. Exactly one role is `default_role_id`, the one people
   * arrive with. Withdrawing a role unmaps the groups naming it and keeps
   * their members in the organization; an empty list is refused while a
   * directory is connected. Your API key only: an organization admin's
   * token can read the list but is refused changing it.
   */
  setDirectoryGrantableRoles(
    id: string,
    input: RequestBody<"ApiOrganizationDirectoryController_setGrantableRoles">,
  ): Promise<
    ResponseBody<"ApiOrganizationDirectoryController_setGrantableRoles">
  > {
    return this.client.request(
      "PUT",
      `/api/v1/organizations/${enc(id)}/directory/grantable-roles`,
      { body: input },
    );
  }

  /**
   * The organization's directory, its full SCIM base URL, and the roles it
   * may grant. `id` is null until a directory is connected.
   */
  getDirectory(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_get">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/directory`,
    );
  }

  /** Connect a directory. Refused until the organization's roles are set. */
  createDirectory(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_create">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/directory`,
    );
  }

  /**
   * End the connection. The people it provisioned keep their accounts and
   * their membership; what ends is the provider's ability to push.
   */
  removeDirectory(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/directory`,
    );
  }

  listDirectoryTokens(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_listTokens">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/directory/tokens`,
    );
  }

  /**
   * The raw token is in this answer and nowhere else, alongside the full
   * base URL the identity provider's connector needs with it.
   */
  mintDirectoryToken(
    id: string,
    input: RequestBody<"ApiOrganizationDirectoryController_mintToken"> = {},
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_mintToken">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/directory/tokens`,
      { body: input },
    );
  }

  /**
   * A replacement token, shown once. The old one keeps working for a short
   * overlap, so the provider can be moved across without an outage.
   */
  rotateDirectoryToken(
    id: string,
    tokenId: string,
    input: RequestBody<"ApiOrganizationDirectoryController_rotateToken"> = {},
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_rotateToken">> {
    return this.client.request(
      "POST",
      `/api/v1/organizations/${enc(id)}/directory/tokens/${enc(tokenId)}/rotate`,
      { body: input },
    );
  }

  revokeDirectoryToken(id: string, tokenId: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/directory/tokens/${enc(tokenId)}`,
    );
  }

  /** The organization's own provisioning events, newest first. */
  listDirectoryActivity(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryController_activity">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/directory/activity`,
    );
  }

  /** The groups the provider has pushed, each with its role mapping. */
  listDirectoryGroups(
    id: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryGroupsController_list">> {
    return this.client.request(
      "GET",
      `/api/v1/organizations/${enc(id)}/directory/groups`,
    );
  }

  /**
   * Grant a listed role to every member of a pushed group, at the
   * organization. A role not on the organization's list is refused with
   * `scim.role_not_grantable`.
   */
  mapDirectoryGroup(
    id: string,
    groupId: string,
    input: RequestBody<"ApiOrganizationDirectoryGroupsController_map">,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryGroupsController_map">> {
    return this.client.request(
      "PUT",
      `/api/v1/organizations/${enc(id)}/directory/groups/${enc(groupId)}/mapping`,
      { body: input },
    );
  }

  /** Members fall back to the arrival role and stay in the organization. */
  unmapDirectoryGroup(
    id: string,
    groupId: string,
  ): Promise<ResponseBody<"ApiOrganizationDirectoryGroupsController_unmap">> {
    return this.client.request(
      "DELETE",
      `/api/v1/organizations/${enc(id)}/directory/groups/${enc(groupId)}/mapping`,
    );
  }
}

export type OrganizationItem = ItemOf<
  ResponseBody<"ApiOrganizationsController_listOrganizations">
>;
export type OrganizationMemberItem = ItemOf<
  ResponseBody<"ApiOrganizationsController_listMembers">
>;
export type OrganizationInviteItem = ItemOf<
  ResponseBody<"ApiOrganizationsController_listInvites">
>;

type ItemOf<T> = T extends { items: (infer Item)[] } ? Item : never;

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
