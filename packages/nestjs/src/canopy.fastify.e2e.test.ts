import { Controller, Get, Logger, Module, UseGuards } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CanopyGuard } from "./canopy.guard.js";
import { CanopyModule } from "./canopy.module.js";
import { RequirePermission } from "./require-permission.decorator.js";

/**
 * The guard on Fastify, which is the other platform Nest runs on.
 *
 * Almost nothing in this package is platform-specific — but the disconnect
 * watch reaches for the raw Node response, and the two adapters do not hand
 * back the same object. Express returns the `ServerResponse` itself; Fastify
 * returns a `Reply`, a plain object with the real response on `.raw`. A stub of
 * that shape can assert the branch is taken, but only the real adapter proves
 * the shape was right in the first place.
 */

interface TestRequest {
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Set per test: which grant roots the identity holds. */
let respond: () => Promise<Response> = () =>
  Promise.resolve(
    json({ items: [{ permission: "orders.refund", nodes: ["nod_1"] }] }),
  );

const fakeFetch = ((url: unknown) => {
  const href = String(url);

  if (href.includes("/nodes")) {
    return Promise.resolve(
      json({ items: [{ id: "nod_1", parent_node_id: null }] }),
    );
  }

  return respond();
}) as unknown as typeof globalThis.fetch;

@Controller()
@UseGuards(CanopyGuard)
class TestController {
  @Get("orgs/:orgId/refund")
  @RequirePermission("orders.refund")
  refund() {
    return { ok: true };
  }
}

@Module({
  imports: [
    CanopyModule.forRoot<TestRequest>({
      apiKey: "cnpy_test",
      baseUrl: "https://api.test",
      maxRetries: 0,
      fetch: fakeFetch,
      resolveIdentity: (request) => request.headers["x-identity"],
      resolveNode: (request) => request.params["orgId"],
    }),
  ],
  controllers: [TestController],
})
class TestApp {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  vi.spyOn(Logger, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  app = await NestFactory.create<NestFastifyApplication>(
    TestApp,
    new FastifyAdapter(),
    { logger: false },
  );

  // Fastify binds lazily; listening on 0 then reading the address is how the
  // real port is discovered.
  await app.listen(0, "127.0.0.1");

  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("the guard on a real Fastify app", () => {
  it("allows a guarded route when Canopy allows", async () => {
    const response = await fetch(`${base}/orgs/nod_1/refund`, {
      headers: { "x-identity": "idn_1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("denies when the identity holds the permission nowhere", async () => {
    respond = () => Promise.resolve(json({ items: [] }));

    // A different identity from the allowed case: grant roots are cached per
    // identity for the life of the app, so reusing one would be answered from
    // the warm entry and never reach the fake.
    const response = await fetch(`${base}/orgs/nod_1/refund`, {
      headers: { "x-identity": "idn_denied" },
    });

    expect(response.status).toBe(403);
  });

  /**
   * Cancellation is no longer plumbed down to `fetch`, and deliberately so: a
   * read in flight may be shared with other requests, and cancelling it
   * because one caller hung up would abort a fetch the others are waiting on.
   * The authorizer races the caller's signal instead — proven in
   * `authorizer.test.ts` — and that the guard finds the Fastify stream on
   * `.raw` to produce that signal is proven in `canopy.guard.test.ts`.
   *
   * What remains worth checking here is that a real Fastify pipeline reaches
   * the guard at all, which the two cases above cover.
   */
});
