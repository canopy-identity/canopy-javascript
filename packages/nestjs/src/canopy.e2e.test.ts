import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Controller, Get, Logger, Module, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CanopyGuard } from "./canopy.guard.js";
import { CanopyModule } from "./canopy.module.js";
import { RequirePermission } from "./require-permission.decorator.js";

/**
 * The guard driven through a real Nest HTTP pipeline rather than a mocked
 * `ExecutionContext`.
 *
 * This is what the unit tests cannot show: that the decorator's metadata is
 * actually readable by a real `Reflector` at request time, that the guard is
 * constructible by the injector when built with esbuild — which emits no
 * `design:paramtypes` — and that each refusal maps to the status code a caller
 * would really receive.
 *
 * Canopy itself is faked at the `fetch` boundary, so the client's own
 * behaviour is exercised alongside the guard.
 */

type FetchResult = { status: number; body: unknown };

let nextResponse: () => FetchResult = () => ({
  status: 200,
  body: { data: { allowed: true } },
});

const fakeFetch = (() => {
  const { status, body } = nextResponse();

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}) as unknown as typeof globalThis.fetch;

interface TestRequest {
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
}

@Controller()
@UseGuards(CanopyGuard)
class TestController {
  @Get("open")
  open() {
    return { ok: true };
  }

  @Get("orgs/:orgId/refund")
  @RequirePermission("orders.refund")
  refund() {
    return { ok: true };
  }

  @Get("reports")
  @RequirePermission("reports.view", { scope: "app_wide" })
  reports() {
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
  // Nest's boot banner and the guard's own error log are expected here.
  vi.spyOn(Logger, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  app = await NestFactory.create(TestApp, { logger: false });
  await app.listen(0);

  // getHttpServer() is typed `any`; naming the type keeps the call checked.
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;

  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

function call(path: string, identity?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: identity === undefined ? {} : { "x-identity": identity },
  });
}

describe("a real request through the guard", () => {
  it("allows an undecorated route with no identity at all", async () => {
    const response = await call("/open");

    expect(response.status).toBe(200);
  });

  it("allows a guarded route when Canopy allows", async () => {
    nextResponse = () => ({ status: 200, body: { data: { allowed: true } } });

    const response = await call("/orgs/nod_1/refund", "idn_1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 403 when Canopy denies", async () => {
    nextResponse = () => ({ status: 200, body: { data: { allowed: false } } });

    const response = await call("/orgs/nod_1/refund", "idn_1");

    expect(response.status).toBe(403);
  });

  it("returns 403 when the request carries no identity", async () => {
    nextResponse = () => ({ status: 200, body: { data: { allowed: true } } });

    const response = await call("/orgs/nod_1/refund");

    expect(response.status).toBe(403);
  });

  /**
   * The property the whole package exists to hold: Canopy failing must not
   * become an allow, and must not be reported as a policy denial either.
   */
  it("returns 503, not 403 and not 200, when Canopy errors", async () => {
    nextResponse = () => ({
      status: 500,
      body: { error: { code: "internal", message: "boom" } },
    });

    const response = await call("/orgs/nod_1/refund", "idn_1");

    expect(response.status).toBe(503);
  });

  it("evaluates an app_wide route without needing a node in the path", async () => {
    nextResponse = () => ({ status: 200, body: { data: { allowed: true } } });

    const response = await call("/reports", "idn_1");

    expect(response.status).toBe(200);
  });
});
