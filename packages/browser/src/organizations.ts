import { apiRequest, asCanopyError, retryAtFor, type ApiDeps } from "./api.js";
import type { CanopyAuthError, CanopyConnectionError } from "./errors.js";

/** An organization the signed-in person belongs to, as the API names it. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  /** The roles the person holds at the organization. */
  roles: { id: string; name: string }[];
  /** A role held here manages the organization itself. */
  administers: boolean;
  /** The person administers something inside the organization. */
  portal_access: boolean;
}

/** What the client knows about the person's organizations now. */
export type OrganizationsState =
  | { status: "loading" }
  | { status: "loaded"; organizations: Organization[] }
  | { status: "error"; error: CanopyAuthError | CanopyConnectionError };

/** The most the API returns on one page; the list is read a page at a time. */
export const ORGANIZATIONS_PAGE_SIZE = 100;

const LOADING: OrganizationsState = Object.freeze({ status: "loading" });

/**
 * The person's organizations, read from the API once and held until the
 * token changes or the person signs out, like a permission answer. Every end
 * user's browser makes this call, so its cost is the product's cost: one
 * request per 100 organizations, never on a timer or a re-render, and a
 * failure held before it is asked again.
 */
export class OrganizationList {
  readonly #deps: ApiDeps;

  #state: OrganizationsState = LOADING;
  #reading: Promise<Organization[]> | undefined;
  #retryAt = 0;
  #generation = 0;

  constructor(deps: ApiDeps) {
    this.#deps = deps;
  }

  /** What is known now, without asking. Stable until it changes. */
  state(): OrganizationsState {
    return this.#state;
  }

  /** The organizations, asking the API only when nothing is held. */
  list(): Promise<Organization[]> {
    if (this.#state.status === "loaded") {
      return Promise.resolve(this.#state.organizations);
    }

    if (this.#state.status === "error" && this.#deps.now() < this.#retryAt) {
      return Promise.reject(this.#state.error);
    }

    this.#reading ??= this.#read(this.#generation);

    return this.#reading;
  }

  /** Forget what is held: the token changed, or nobody is signed in. */
  clear(): void {
    this.#generation += 1;
    this.#reading = undefined;

    if (this.#state !== LOADING) {
      this.#state = LOADING;
      this.#deps.changed();
    }
  }

  async #read(generation: number): Promise<Organization[]> {
    try {
      const organizations = await this.#readAll();

      if (generation === this.#generation) {
        this.#reading = undefined;
        this.#state = Object.freeze({ status: "loaded", organizations });
        this.#deps.changed();
      }

      return organizations;
    } catch (caught) {
      const error = asCanopyError(caught);

      if (generation === this.#generation) {
        this.#reading = undefined;
        this.#state = Object.freeze({ status: "error", error });
        this.#retryAt = retryAtFor(error, this.#deps.now());
        this.#deps.changed();
      }

      throw error;
    }
  }

  async #readAll(): Promise<Organization[]> {
    const token = await this.#deps.accessToken();

    if (!token) {
      return [];
    }

    const organizations: Organization[] = [];

    for (let page = 1; ; page += 1) {
      const body = (await apiRequest(
        this.#deps,
        `/v1/identity/auth/organizations?page=${page}&take=${ORGANIZATIONS_PAGE_SIZE}&sort_by=name&order=asc`,
        token,
        { method: "GET" },
      )) as {
        items: Organization[];
        pagination?: { page_count?: number };
      };

      organizations.push(...body.items);

      if (page >= (body.pagination?.page_count ?? 1)) {
        return organizations;
      }
    }
  }
}
