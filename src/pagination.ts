import { type Collection, isCursorPagination } from "./client.js";

/** Query parameters for one page request. */
export type PageParams = Record<
  string,
  string | number | boolean | undefined | null
>;

/** Fetches a single page. Supplied by each resource. */
export type PageFetcher<T> = (params: PageParams) => Promise<Collection<T>>;

export interface PaginateOptions {
  /** Stop after this many pages. Guards against a server that never ends. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 1_000;

/**
 * Walks a paginated endpoint without the caller knowing which pagination style
 * it uses.
 *
 * This exists because the two styles are indistinguishable at the top level:
 * both answer `{ items, pagination }`. Offset carries
 * `page`/`has_next_page`; cursor carries `next_cursor`. The audit log is
 * cursor-paginated and everything else is offset, so a hand-written loop works
 * against one and silently reads only the first page of the other — or loops
 * forever.
 *
 * The style is inferred from the first response rather than declared, so a
 * resource does not have to restate what the server already says. Only the
 * cursor or page parameter is managed here; page size stays whatever the
 * caller passed, because the two styles even name that differently (`take` for
 * offset, `limit` for the cursor feeds).
 */
export class Paginator<T> implements AsyncIterable<T> {
  private readonly fetchPage: PageFetcher<T>;
  private readonly initial: PageParams;
  private readonly maxPages: number;

  constructor(
    fetchPage: PageFetcher<T>,
    initial: PageParams = {},
    options: PaginateOptions = {},
  ) {
    this.fetchPage = fetchPage;
    this.initial = initial;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /** Every item across every page. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for await (const page of this.pages()) {
      for (const item of page.items) {
        yield item;
      }
    }
  }

  /**
   * Page by page, for callers that need the pagination metadata or want to
   * process in batches rather than item by item.
   */
  async *pages(): AsyncGenerator<Collection<T>> {
    let params: PageParams = { ...this.initial };
    let seenCursor: string | null = null;
    let pageCount = 0;

    for (;;) {
      const page = await this.fetchPage(params);

      pageCount++;

      yield page;

      const pagination = page.pagination;

      // No pagination object at all: an unpaginated `{ items }` collection.
      if (!pagination) {
        return;
      }

      // A server that keeps promising more while returning nothing would spin
      // forever; the empty page is the honest end of the feed.
      if (page.items.length === 0) {
        return;
      }

      if (pageCount >= this.maxPages) {
        return;
      }

      if (isCursorPagination(pagination)) {
        const next = pagination.next_cursor;

        if (next === null || next === seenCursor) {
          // Null is the documented end. An unchanged cursor means the server
          // is not advancing, which would otherwise be an infinite loop.
          return;
        }

        seenCursor = next;
        params = { ...params, cursor: next };

        continue;
      }

      if (!pagination.has_next_page) {
        return;
      }

      params = { ...params, page: pagination.page + 1 };
    }
  }

  /**
   * Collect everything into an array.
   *
   * Bounded on purpose: an unbounded drain of an audit log will exhaust memory
   * on a busy account, so the cap is a parameter rather than a footnote. Use
   * the iterator for large feeds.
   */
  async all(max = 10_000): Promise<T[]> {
    const collected: T[] = [];

    for await (const item of this) {
      collected.push(item);

      if (collected.length >= max) {
        break;
      }
    }

    return collected;
  }

  /** The first item, or undefined. Stops after one page. */
  async first(): Promise<T | undefined> {
    for await (const item of this) {
      return item;
    }

    return undefined;
  }
}

/** Convenience wrapper so resources read as `paginate(fetch, params)`. */
export function paginate<T>(
  fetchPage: PageFetcher<T>,
  initial: PageParams = {},
  options: PaginateOptions = {},
): Paginator<T> {
  return new Paginator(fetchPage, initial, options);
}
