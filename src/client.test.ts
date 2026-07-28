import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanopyClient, isCursorPagination } from "./client.js";
import { CanopyConnectionError, CanopyError, isCanopyError } from "./errors.js";

/** A fetch stub that replays queued responses and records what it was called with. */
function stubFetch(responses: (Response | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    // `Request` has no useful stringification, so read its `url` instead.
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    calls.push({ url: href, init: init ?? {} });

    const next = responses[Math.min(index, responses.length - 1)];

    index++;

    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve(next as Response);
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function client(fetchImpl: typeof globalThis.fetch, overrides = {}) {
  return new CanopyClient({
    apiKey: "cnpy_test",
    baseUrl: "https://api.test",
    maxRetries: 2,
    timeoutMs: 0,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe("construction", () => {
  it("refuses to build without a credential", () => {
    // Legal TypeScript — both credentials are optional in the options type —
    // so this has to be a runtime guard, which is exactly why it is tested.
    expect(() => new CanopyClient({ baseUrl: "https://api.test" })).toThrow(
      /requires either `apiKey`/,
    );
  });

  it("sends an API key as X-API-Key", async () => {
    const { fetch, calls } = stubFetch([json({ data: { id: "1" } })]);

    await client(fetch).request("GET", "/api/v1/roles");

    expect(
      (calls[0]?.init.headers as Record<string, string>)["X-API-Key"],
    ).toBe("cnpy_test");
  });

  it("sends a JWT as a bearer token", async () => {
    const { fetch, calls } = stubFetch([json({ data: {} })]);
    const jwtClient = new CanopyClient({
      accessToken: "jwt-abc",
      baseUrl: "https://api.test",
      fetch,
    });

    await jwtClient.request("GET", "/portal/v1/me");

    expect(
      (calls[0]?.init.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer jwt-abc");
  });
});

describe("envelope unwrapping", () => {
  it("returns the resource from a { data } envelope", async () => {
    const { fetch } = stubFetch([json({ data: { id: "role_1" } })]);

    await expect(
      client(fetch).request("GET", "/api/v1/roles/1"),
    ).resolves.toEqual({ id: "role_1" });
  });

  /** Pagination is the caller's business, so a collection is returned whole. */
  it("keeps items and pagination together", async () => {
    const { fetch } = stubFetch([
      json({ items: [{ id: "a" }], pagination: { page: 1, take: 20 } }),
    ]);

    const page = await client(fetch).request<{
      items: unknown[];
      pagination: unknown;
    }>("GET", "/api/v1/identities");

    expect(page.items).toHaveLength(1);
    expect(page.pagination).toEqual({ page: 1, take: 20 });
  });

  it("returns undefined for 204", async () => {
    const { fetch } = stubFetch([new Response(null, { status: 204 })]);

    await expect(
      client(fetch).request("DELETE", "/api/v1/roles/1"),
    ).resolves.toBeUndefined();
  });

  it("returns a 207 partial success whole", async () => {
    const { fetch } = stubFetch([
      json(
        { summary: { total: 2, succeeded: 1, failed: 1 }, results: [] },
        { status: 207 },
      ),
    ]);

    const result = await client(fetch).request<{ summary: { failed: number } }>(
      "POST",
      "/api/v1/assignments/bulk",
    );

    expect(result.summary.failed).toBe(1);
  });
});

describe("errors", () => {
  it("throws CanopyError carrying the machine-readable code", async () => {
    const { fetch } = stubFetch([
      json(
        {
          error: {
            statusCode: 409,
            code: "rbac.assignment_conflict",
            message: "Identity already has this role at this node",
          },
        },
        { status: 409 },
      ),
    ]);

    const error = await client(fetch)
      .request("POST", "/api/v1/assignments")
      .catch((e: unknown) => e);

    expect(isCanopyError(error)).toBe(true);
    expect((error as CanopyError).code).toBe("rbac.assignment_conflict");
    expect((error as CanopyError).statusCode).toBe(409);
  });

  it("exposes validation details from a 400", async () => {
    const { fetch } = stubFetch([
      json(
        {
          error: {
            statusCode: 400,
            code: null,
            message: "Bad Request",
            details: ["email must be an email"],
          },
        },
        { status: 400 },
      ),
    ]);

    const error = (await client(fetch)
      .request("POST", "/api/v1/identities")
      .catch((e: unknown) => e)) as CanopyError;

    expect(error.details).toEqual(["email must be an email"]);
  });

  it("flags auth failures", async () => {
    const { fetch } = stubFetch([
      json(
        { error: { statusCode: 401, code: null, message: "Invalid token" } },
        { status: 401 },
      ),
    ]);

    const error = (await client(fetch)
      .request("GET", "/api/v1/roles")
      .catch((e: unknown) => e)) as CanopyError;

    expect(error.isAuthFailure).toBe(true);
  });

  /** A proxy's HTML error page must not surface as a JSON parse crash. */
  it("survives a non-JSON error body", async () => {
    const { fetch } = stubFetch([
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    ]);

    const error = (await client(fetch, { maxRetries: 0 })
      .request("GET", "/api/v1/roles")
      .catch((e: unknown) => e)) as CanopyError;

    expect(error.statusCode).toBe(502);
    expect(error.message).toContain("502");
  });

  it("wraps a transport failure as CanopyConnectionError", async () => {
    const { fetch } = stubFetch([new TypeError("network down")]);

    const error = await client(fetch, { maxRetries: 0 })
      .request("GET", "/api/v1/roles")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CanopyConnectionError);
  });
});

describe("retry policy", () => {
  beforeEach(() => {
    // Backoff is real time; keep the suite fast without faking the clock.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  it("retries a 429 even on POST, because nothing was processed", async () => {
    const { fetch, calls } = stubFetch([
      json(
        { error: { statusCode: 429, code: null, message: "Slow down" } },
        {
          status: 429,
          headers: { "retry-after": "0" },
        },
      ),
      json({ data: { id: "ok" } }),
    ]);

    await expect(
      client(fetch).request("POST", "/api/v1/identities"),
    ).resolves.toEqual({ id: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("retries a 500 on GET", async () => {
    const { fetch, calls } = stubFetch([
      json(
        { error: { statusCode: 500, code: null, message: "boom" } },
        {
          status: 500,
        },
      ),
      json({ data: { id: "ok" } }),
    ]);

    await expect(
      client(fetch).request("GET", "/api/v1/roles"),
    ).resolves.toEqual({ id: "ok" });
    expect(calls).toHaveLength(2);
  });

  /**
   * The important one. A repeated POST can create a second role assignment or
   * a second invitation, and a 500 says nothing about whether the first took
   * effect.
   */
  it("does NOT retry a 500 on POST", async () => {
    const { fetch, calls } = stubFetch([
      json(
        { error: { statusCode: 500, code: null, message: "boom" } },
        {
          status: 500,
        },
      ),
    ]);

    await expect(
      client(fetch).request("POST", "/api/v1/assignments"),
    ).rejects.toBeInstanceOf(CanopyError);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST when the caller declares it idempotent", async () => {
    const { fetch, calls } = stubFetch([
      json(
        { error: { statusCode: 500, code: null, message: "boom" } },
        {
          status: 500,
        },
      ),
      json({ data: { id: "ok" } }),
    ]);

    await client(fetch).request("POST", "/api/v1/api-keys", {
      idempotent: true,
    });

    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the last failure", async () => {
    const { fetch, calls } = stubFetch([
      json(
        { error: { statusCode: 503, code: null, message: "unavailable" } },
        {
          status: 503,
        },
      ),
    ]);

    const error = (await client(fetch, { maxRetries: 2 })
      .request("GET", "/api/v1/roles")
      .catch((e: unknown) => e)) as CanopyError;

    expect(error.statusCode).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const { fetch, calls } = stubFetch([
      json(
        {
          error: {
            statusCode: 404,
            code: "nodes.node_not_found",
            message: "nope",
          },
        },
        {
          status: 404,
        },
      ),
    ]);

    await expect(
      client(fetch).request("GET", "/api/v1/nodes/x"),
    ).rejects.toBeInstanceOf(CanopyError);
    expect(calls).toHaveLength(1);
  });
});

describe("query strings", () => {
  it("omits undefined and null rather than sending them", async () => {
    const { fetch, calls } = stubFetch([json({ items: [] })]);

    await client(fetch).request("GET", "/api/v1/identities", {
      query: { take: 20, cursor: undefined, q: null, active: false },
    });

    const url = new URL(calls[0]?.url ?? "");

    expect(url.searchParams.get("take")).toBe("20");
    expect(url.searchParams.get("active")).toBe("false");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("joins the base URL and path without doubling slashes", async () => {
    const { fetch, calls } = stubFetch([json({ items: [] })]);

    await client(fetch, { baseUrl: "https://api.test/" }).request(
      "GET",
      "/api/v1/roles",
    );

    expect(calls[0]?.url).toBe("https://api.test/api/v1/roles");
  });
});

describe("isCursorPagination", () => {
  it("tells the two identical-looking envelopes apart", () => {
    expect(isCursorPagination({ next_cursor: "abc" })).toBe(true);
    expect(
      isCursorPagination({
        page: 1,
        take: 20,
        item_count: 1,
        page_count: 1,
        has_previous_page: false,
        has_next_page: false,
      }),
    ).toBe(false);
  });
});
