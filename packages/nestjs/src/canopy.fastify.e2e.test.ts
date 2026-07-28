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

/** Set per test: how the faked Canopy answers. */
let respond: (signal: AbortSignal | undefined) => Promise<Response> = () =>
  Promise.resolve(
    new Response(JSON.stringify({ data: { allowed: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const fakeFetch = ((_url: unknown, init?: RequestInit) =>
  respond(init?.signal ?? undefined)) as unknown as typeof globalThis.fetch;

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

  it("denies when Canopy denies", async () => {
    respond = () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { allowed: false } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const response = await fetch(`${base}/orgs/nod_1/refund`, {
      headers: { "x-identity": "idn_1" },
    });

    expect(response.status).toBe(403);
  });

  /**
   * The one a stub cannot prove. A real client hangs up on a real Fastify
   * `Reply`; if the guard did not find the response on `.raw`, nothing would
   * abort and the check would run to its deadline instead.
   */
  it("aborts the in-flight check when the caller hangs up", async () => {
    const aborted = new Promise<boolean>((resolve) => {
      respond = (signal) => {
        if (!signal) {
          resolve(false);

          return Promise.resolve(
            new Response(JSON.stringify({ data: { allowed: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        signal.addEventListener("abort", () => resolve(true), { once: true });

        // Never settles on its own: only the disconnect can end this.
        return new Promise<Response>(() => undefined);
      };
    });

    const controller = new AbortController();

    const inflight = fetch(`${base}/orgs/nod_1/refund`, {
      headers: { "x-identity": "idn_1" },
      signal: controller.signal,
    }).catch(() => undefined);

    // Give Fastify time to route and reach the guard before hanging up.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await inflight;

    await expect(aborted).resolves.toBe(true);
  });
});
