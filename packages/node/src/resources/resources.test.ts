import { beforeEach, describe, expect, it, vi } from "vitest";

import { Canopy } from "../canopy.js";

/**
 * These assert the wiring — method to verb, path, and body — because that is
 * what a hand-written wrapper can get wrong in a way types cannot catch. A
 * typo in a URL still compiles.
 */
function harness(body: unknown = { data: { ok: true } }) {
  const calls: {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
  }[] = [];

  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    calls.push({
      url: href,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      // Every body this SDK sends is a JSON string; narrowing says so rather
      // than stringifying a BodyInit that could be a stream.
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  const canopy = new Canopy({
    apiKey: "cnpy_test",
    baseUrl: "https://api.test",
    timeoutMs: 0,
    fetch,
  });

  return { canopy, calls };
}

describe("permissions", () => {
  it("POSTs an evaluation to the evaluate path", async () => {
    const { canopy, calls } = harness({
      data: { allowed: true, permission: "documents.read" },
    });

    const result = await canopy.permissions.evaluate({
      identity_id: "id_1",
      permission: "documents.read",
      scope: "node",
      node_id: "node_1",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test/api/v1/permissions/evaluate");
    expect(calls[0]?.body).toMatchObject({ permission: "documents.read" });
    expect(result.allowed).toBe(true);
  });

  it("uses the bulk path for bulk evaluation", async () => {
    const { canopy, calls } = harness({ data: { results: [] } });

    await canopy.permissions.evaluateBulk({ checks: [] });

    expect(calls[0]?.url).toBe(
      "https://api.test/api/v1/permissions/evaluate/bulk",
    );
  });

  it("uses the explain path, separate from enforcement", async () => {
    const { canopy, calls } = harness();

    await canopy.permissions.explain({
      identity_id: "id_1",
      permission: "documents.read",
      node_id: "node_1",
    });

    expect(calls[0]?.url).toBe(
      "https://api.test/api/v1/permissions/evaluate/explain",
    );
  });
});

describe("identities", () => {
  it("gets by id with the id encoded into the path", async () => {
    const { canopy, calls } = harness();

    await canopy.identities.get("id with space");

    expect(calls[0]?.url).toBe(
      "https://api.test/api/v1/identities/id%20with%20space",
    );
  });

  it("creates with a POST body", async () => {
    const { canopy, calls } = harness({ data: { id: "id_1" } });

    await canopy.identities.create({
      email: "alex@acme.com",
      first_name: "Alex",
      last_name: "Doe",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ email: "alex@acme.com" });
  });

  it("deactivates rather than deleting", async () => {
    const { canopy, calls } = harness();

    await canopy.identities.deactivate("id_1");

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://api.test/api/v1/identities/id_1/deactivate",
    );
  });

  it("returns a paginator that walks the collection", async () => {
    const { canopy, calls } = harness({
      items: [{ id: "a" }],
      pagination: {
        page: 1,
        take: 20,
        item_count: 1,
        page_count: 1,
        has_previous_page: false,
        has_next_page: false,
      },
    });

    const all = await canopy.identities.list({ take: 20 }).all();

    expect(all).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("take")).toBe("20");
  });
});

describe("roles", () => {
  it("replaces permissions with PUT, not PATCH", async () => {
    const { canopy, calls } = harness();

    await canopy.roles.setPermissions("role_1", { permission_keys: [] });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      "https://api.test/api/v1/roles/role_1/permissions",
    );
  });

  it("deletes with DELETE", async () => {
    const { canopy, calls } = harness();

    await canopy.roles.delete("role_1");

    expect(calls[0]?.method).toBe("DELETE");
  });
});

describe("assignments", () => {
  it("grants at the app-wide collection path", async () => {
    const { canopy, calls } = harness({ data: { id: "asgn_1" } });

    await canopy.assignments.create({
      identity_id: "id_1",
      node_id: "node_1",
      role_id: "role_1",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test/api/v1/assignments");
  });

  it("reads the app-wide list, not a bare collection", async () => {
    const { canopy, calls } = harness({ items: [] });

    await canopy.assignments.list().first();

    expect(calls[0]?.url).toContain("/api/v1/assignments/app-wide");
  });

  it("returns a bulk result whole so partial failure is visible", async () => {
    const { canopy } = harness({
      summary: { total: 2, succeeded: 1, failed: 1 },
      results: [],
    });

    const result = await canopy.assignments.bulkCreate({ assignments: [] });

    expect(result.summary.failed).toBe(1);
  });
});

/**
 * This endpoint is paginated (20 per page by default) and reads like one that
 * is not. Returning a single page would under-report what an identity can do —
 * the dangerous direction to be wrong in on an authorization surface.
 */
describe("identity assignments", () => {
  /** Replays a queue of responses so a walk across pages can be observed. */
  function paged(pages: unknown[]) {
    const calls: string[] = [];
    let index = 0;

    const fetch = vi.fn((url: string | URL | Request) => {
      calls.push(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      );

      const body = pages[Math.min(index, pages.length - 1)];

      index++;

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const canopy = new Canopy({
      apiKey: "cnpy_test",
      baseUrl: "https://api.test",
      timeoutMs: 0,
      fetch,
    });

    return { canopy, calls };
  }

  function page(items: unknown[], pageNumber: number, hasNext: boolean) {
    return {
      items,
      pagination: {
        page: pageNumber,
        take: 20,
        item_count: 2,
        page_count: 2,
        has_previous_page: pageNumber > 1,
        has_next_page: hasNext,
      },
    };
  }

  it("walks every page rather than answering the first", async () => {
    const { canopy, calls } = paged([
      page([{ id: "asg_1" }], 1, true),
      page([{ id: "asg_2" }], 2, false),
    ]);

    const all = await canopy.identities.assignments("idn_1").all();

    expect(all).toEqual([{ id: "asg_1" }, { id: "asg_2" }]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1] ?? "").searchParams.get("page")).toBe("2");
  });

  it("passes query parameters through to the first page", async () => {
    const { canopy, calls } = paged([page([{ id: "asg_1" }], 1, false)]);

    await canopy.identities.assignments("idn_1", { take: 50 }).all();

    const url = new URL(calls[0] ?? "");

    expect(url.pathname).toBe("/api/v1/identities/idn_1/assignments");
    expect(url.searchParams.get("take")).toBe("50");
  });
});

/**
 * The spec declares `If-Match` on exactly these four wrapped operations. Without
 * it a read-modify-write silently clobbers a concurrent edit, so the header
 * reaching the wire is the whole point of the option.
 */
describe("optimistic concurrency", () => {
  it("sends If-Match when updating a role", async () => {
    const { canopy, calls } = harness();

    await canopy.roles.update("role_1", { name: "Editor" }, { ifMatch: "3" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers["If-Match"]).toBe("3");
  });

  it("sends If-Match when deleting a role", async () => {
    const { canopy, calls } = harness();

    await canopy.roles.delete("role_1", { ifMatch: "4" });

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers["If-Match"]).toBe("4");
  });

  it("sends If-Match when updating a permission", async () => {
    const { canopy, calls } = harness();

    await canopy.permissions.update(
      "perm_1",
      { name: "Read documents" },
      { ifMatch: "5" },
    );

    expect(calls[0]?.headers["If-Match"]).toBe("5");
  });

  it("sends If-Match when deleting a permission", async () => {
    const { canopy, calls } = harness();

    await canopy.permissions.delete("perm_1", { ifMatch: "6" });

    expect(calls[0]?.headers["If-Match"]).toBe("6");
  });

  /** Omitting it must send no header at all, not an empty or "undefined" one. */
  it("omits If-Match entirely when not supplied", async () => {
    const { canopy, calls } = harness();

    await canopy.roles.update("role_1", { name: "Editor" });

    expect("If-Match" in (calls[0]?.headers ?? {})).toBe(false);
  });
});

/**
 * The evaluations are POSTs only because the question travels in a body. They
 * compute an answer and write nothing, so the client's POST-is-not-idempotent
 * default would otherwise make the hot path the least resilient call in the
 * SDK — giving up on a transient 5xx that a GET would have ridden out.
 */
describe("evaluations retry a 5xx", () => {
  function flaky(failures: number) {
    let seen = 0;

    const fetch = vi.fn(() => {
      seen++;

      if (seen <= failures) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { statusCode: 503, code: null, message: "unavailable" },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ data: { allowed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const canopy = new Canopy({
      apiKey: "cnpy_test",
      baseUrl: "https://api.test",
      timeoutMs: 0,
      fetch,
    });

    return { canopy, fetch };
  }

  beforeEach(() => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  it("retries evaluate", async () => {
    const { canopy, fetch } = flaky(1);

    const decision = await canopy.permissions.evaluate({
      identity_id: "idn_1",
      permission: "documents.read",
      scope: "app_wide",
    });

    expect(decision).toEqual({ allowed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries evaluateBulk", async () => {
    const { canopy, fetch } = flaky(1);

    await canopy.permissions.evaluateBulk({ checks: [] });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries explain", async () => {
    const { canopy, fetch } = flaky(1);

    await canopy.permissions.explain({
      identity_id: "idn_1",
      permission: "documents.read",
      node_id: "nod_1",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  /** Creating is still not repeated — the distinction has to hold. */
  it("still does not retry a create", async () => {
    const { canopy, fetch } = flaky(1);

    await expect(
      canopy.identities.create({
        email: "a@b.com",
        first_name: "Ada",
        last_name: "Lovelace",
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the escape hatch", () => {
  /**
   * The wrapped resources cover the common paths, not all 81 operations. An
   * unwrapped endpoint must still be reachable with the same envelope handling
   * and error typing, or the SDK becomes a ceiling.
   */
  it("reaches an unwrapped endpoint through the client", async () => {
    const { canopy, calls } = harness({ items: [] });

    await canopy.client.request("GET", "/api/v1/audit-events", {
      query: { limit: 10 },
    });

    expect(calls[0]?.url).toBe("https://api.test/api/v1/audit-events?limit=10");
  });
});
