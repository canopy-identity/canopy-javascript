import { describe, expect, it } from "vitest";

import type { Collection } from "./client.js";
import { type PageParams, paginate } from "./pagination.js";

/** Records the params of every page request so the walk itself can be asserted. */
function recorder<T>(pages: Collection<T>[]) {
  const requests: PageParams[] = [];
  let index = 0;

  const fetchPage = (params: PageParams): Promise<Collection<T>> => {
    requests.push({ ...params });

    const page = pages[Math.min(index, pages.length - 1)];

    index++;

    return Promise.resolve(page as Collection<T>);
  };

  return { fetchPage, requests };
}

function offset(
  items: number[],
  page: number,
  hasNext: boolean,
): Collection<number> {
  return {
    items,
    pagination: {
      page,
      take: items.length,
      item_count: 0,
      page_count: 0,
      has_previous_page: page > 1,
      has_next_page: hasNext,
    },
  };
}

function cursor(items: number[], next: string | null): Collection<number> {
  return { items, pagination: { next_cursor: next } };
}

describe("offset pagination", () => {
  it("walks pages until has_next_page is false", async () => {
    const { fetchPage, requests } = recorder([
      offset([1, 2], 1, true),
      offset([3, 4], 2, true),
      offset([5], 3, false),
    ]);

    const items = await paginate(fetchPage, { take: 2 }).all();

    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(requests.map((r) => r["page"])).toEqual([undefined, 2, 3]);
  });

  it("carries the caller's other params on every page", async () => {
    const { fetchPage, requests } = recorder([
      offset([1], 1, true),
      offset([2], 2, false),
    ]);

    await paginate(fetchPage, { take: 1, q: "acme" }).all();

    expect(requests.every((r) => r["q"] === "acme")).toBe(true);
    expect(requests.every((r) => r["take"] === 1)).toBe(true);
  });
});

describe("cursor pagination", () => {
  it("follows next_cursor until it is null", async () => {
    const { fetchPage, requests } = recorder([
      cursor([1, 2], "c1"),
      cursor([3], "c2"),
      cursor([4], null),
    ]);

    const items = await paginate(fetchPage, { limit: 2 }).all();

    expect(items).toEqual([1, 2, 3, 4]);
    expect(requests.map((r) => r["cursor"])).toEqual([undefined, "c1", "c2"]);
  });

  /**
   * The audit log names its page size `limit`, offset endpoints name it `take`.
   * The walker must not assume either — it only ever sets cursor or page.
   */
  it("does not rename the caller's page-size parameter", async () => {
    const { fetchPage, requests } = recorder([cursor([1], null)]);

    await paginate(fetchPage, { limit: 50 }).all();

    expect(requests[0]).toEqual({ limit: 50 });
  });
});

describe("termination", () => {
  it("stops on an unpaginated collection", async () => {
    const { fetchPage, requests } = recorder([{ items: [1, 2] }]);

    const items = await paginate(fetchPage).all();

    expect(items).toEqual([1, 2]);
    expect(requests).toHaveLength(1);
  });

  /** A server promising more while returning nothing would otherwise spin. */
  it("stops when a page comes back empty despite has_next_page", async () => {
    const { fetchPage, requests } = recorder([
      offset([1], 1, true),
      offset([], 2, true),
    ]);

    const items = await paginate(fetchPage).all();

    expect(items).toEqual([1]);
    expect(requests).toHaveLength(2);
  });

  /** An unchanged cursor means no progress — the classic infinite loop. */
  it("stops when the cursor does not advance", async () => {
    const { fetchPage, requests } = recorder([
      cursor([1], "same"),
      cursor([2], "same"),
    ]);

    const items = await paginate(fetchPage).all();

    expect(items).toEqual([1, 2]);
    expect(requests).toHaveLength(2);
  });

  it("honours maxPages as a backstop", async () => {
    const { fetchPage, requests } = recorder([offset([1], 1, true)]);

    await paginate(fetchPage, {}, { maxPages: 3 }).all();

    expect(requests).toHaveLength(3);
  });

  it("caps `all` so a large feed cannot exhaust memory", async () => {
    const { fetchPage } = recorder([cursor([1, 2, 3], "next")]);

    const items = await paginate(fetchPage).all(4);

    expect(items).toHaveLength(4);
  });
});

describe("iteration helpers", () => {
  it("iterates items lazily with for-await", async () => {
    const { fetchPage, requests } = recorder([
      offset([1, 2], 1, true),
      offset([3], 2, false),
    ]);

    const seen: number[] = [];

    for await (const item of paginate(fetchPage)) {
      seen.push(item);
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(2);
  });

  it("exposes pages for callers that need the metadata", async () => {
    const { fetchPage } = recorder([
      offset([1], 1, true),
      offset([2], 2, false),
    ]);

    const totals: number[] = [];

    for await (const page of paginate(fetchPage).pages()) {
      totals.push(page.items.length);
    }

    expect(totals).toEqual([1, 1]);
  });

  /** `first` must not walk the whole feed to answer. */
  it("fetches only one page for first()", async () => {
    const { fetchPage, requests } = recorder([
      offset([7, 8], 1, true),
      offset([9], 2, false),
    ]);

    await expect(paginate(fetchPage).first()).resolves.toBe(7);
    expect(requests).toHaveLength(1);
  });

  it("returns undefined from first() on an empty feed", async () => {
    const { fetchPage } = recorder([{ items: [] }]);

    await expect(paginate(fetchPage).first()).resolves.toBeUndefined();
  });
});
