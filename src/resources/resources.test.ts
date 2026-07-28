import { describe, expect, it, vi } from "vitest";

import { Canopy } from "../canopy.js";

/**
 * These assert the wiring — method to verb, path, and body — because that is
 * what a hand-written wrapper can get wrong in a way types cannot catch. A
 * typo in a URL still compiles.
 */
function harness(body: unknown = { data: { ok: true } }) {
  const calls: { url: string; method: string; body: unknown }[] = [];

  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    calls.push({
      url: href,
      method: init?.method ?? "GET",
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
    fetch: fetch as unknown as typeof globalThis.fetch,
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
