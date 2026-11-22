import type { CanopyClient } from "../client.js";

type Read = (...args: never[]) => unknown;

/**
 * A fake client for the authorizer's tests, built from a plain `request` and
 * a `requestConditional` that serves the hierarchy.
 *
 * The authorizer asks for a subject's first page of grants conditionally, to
 * revalidate what it holds. This routes that request to `request`, answered in
 * full with no validator, so a test that fakes the grants as a plain read
 * keeps counting them on `request`, and `requestConditional` stays the
 * hierarchy's alone. A test of the grants' own revalidation fakes the client
 * itself.
 */
export function fakeClient(fakes: {
  request: Read;
  requestConditional: Read;
}): CanopyClient {
  const request = fakes.request as (...args: unknown[]) => unknown;
  const tree = fakes.requestConditional as (...args: unknown[]) => unknown;

  return {
    request,
    requestConditional: async (
      method: string,
      path: string,
      etag: string | undefined,
      options: unknown,
    ) =>
      path.endsWith("/grants")
        ? {
            modified: true,
            data: await request(method, path, options),
            etag: null,
          }
        : tree(method, path, etag, options),
  } as unknown as CanopyClient;
}
