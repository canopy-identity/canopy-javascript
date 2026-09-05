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
