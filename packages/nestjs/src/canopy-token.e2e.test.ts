import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Controller, Get, Logger, Module, UseGuards } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CanopyTokenClaims } from "@canopy-io/node";

import { CanopyGuard } from "./canopy.guard.js";
import { CanopyModule } from "./canopy.module.js";
import { CanopyTokenGuard } from "./canopy-token.guard.js";
import { RequirePermission } from "./require-permission.decorator.js";

/**
 * Both guards on one route, through a real Nest pipeline.
 *
 * The unit tests prove each half in isolation. What they cannot show is the
 * thing the design actually rests on: that `CanopyTokenGuard` runs first, and
 * that what it attaches is what `resolveIdentity` reads. If that handoff were
 * wrong, both guards would still pass their own tests while every request
 * authorized the wrong subject — or none.
 *
 * Tokens are signed here with a generated key, and the JWKS and evaluate calls
 * are faked at the `fetch` boundary, so the verifier's real signature check
 * runs against a real signature.
 */

const ISSUER = "https://auth.test.example";

interface Signer {
  jwk: Record<string, unknown>;
  sign: (claims: Record<string, unknown>) => Promise<string>;
}

async function makeSigner(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const exported = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as Record<string, unknown>;

  const b64 = (value: string): string =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return {
    jwk: { ...exported, kid: "e2e", alg: "RS256", use: "sig" },
    async sign(claims) {
      const head = b64(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e" }),
      );
      const body = b64(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );

      let binary = "";

      for (const byte of new Uint8Array(signature)) {
        binary += String.fromCharCode(byte);
      }

      return `${head}.${body}.${b64(binary)}`;
    },
  };
}

let signer: Signer;
let allowed = true;
/** Which subject the authorization call was asked about. */
let evaluatedIdentity: string | undefined;

/** Serves the JWKS, the identity's grant roots, and the hierarchy, by URL. */
const fakeFetch = ((url: string | URL | Request) => {
  const href =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

  if (href.includes("/.well-known/jwks.json")) {
    return Promise.resolve(
      new Response(JSON.stringify({ keys: [signer.jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  if (href.includes("/nodes")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ items: [{ id: "nod_1", parent_node_id: null }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  }

  // The subject now rides in the path of the grants read rather than in an
  // evaluate body, but the thing under test is the same: which identity the
  // guard asked about.
  evaluatedIdentity = /\/identities\/([^/]+)\/grants/.exec(href)?.[1];

  return Promise.resolve(
    new Response(
      JSON.stringify({
        items: allowed
          ? [{ permission: "reports.view", nodes: ["nod_1"] }]
          : [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}) satisfies typeof globalThis.fetch;

interface TestRequest {
  canopyToken?: CanopyTokenClaims;
  params: Record<string, string>;
}

@Controller()
// Order is the design: verify first, then authorize what was verified.
@UseGuards(CanopyTokenGuard, CanopyGuard)
class TestController {
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
      verify: { issuer: ISSUER, fetch: fakeFetch },
      // The handoff: the subject comes from what the token guard verified,
      // never from anything the caller can set directly.
      resolveIdentity: (request) => request.canopyToken?.sub,
    }),
  ],
  controllers: [TestController],
})
class TestApp {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  signer = await makeSigner();

  vi.spyOn(Logger, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  app = await NestFactory.create(TestApp, { logger: false });
  await app.listen(0);

  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;

  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "idn_e2e",
    type: "identity",
    iss: ISSUER,
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

function call(token?: string): Promise<Response> {
  return fetch(`${base}/reports`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("CanopyTokenGuard and CanopyGuard on one route", () => {
  it("verifies the token, then authorizes the subject it carried", async () => {
    allowed = true;
    evaluatedIdentity = undefined;

    const response = await call(await signer.sign(claims({ sub: "idn_e2e" })));

    expect(response.status).toBe(200);
    // The handoff worked: the identity evaluated is the one in the token.
    expect(evaluatedIdentity).toBe("idn_e2e");
  });

  it("401s with no token, and never reaches the authorization call", async () => {
    evaluatedIdentity = undefined;

    const response = await call();

    expect(response.status).toBe(401);
    expect(evaluatedIdentity).toBeUndefined();
  });

  it("401s on a token this issuer did not sign", async () => {
    const impostor = await makeSigner();
    evaluatedIdentity = undefined;

    const response = await call(await impostor.sign(claims()));

    expect(response.status).toBe(401);
    expect(evaluatedIdentity).toBeUndefined();
  });

  it("401s on an expired token", async () => {
    const response = await call(
      await signer.sign(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })),
    );

    expect(response.status).toBe(401);
  });

  /**
   * A pre-auth token authenticates but grants nothing. The distinction that
   * matters: this is a 401 from the token guard, not a 403 from the
   * authorization guard — the request never becomes a permission question.
   */
  it("401s on a pre-auth token, without asking about permissions", async () => {
    evaluatedIdentity = undefined;

    const response = await call(
      await signer.sign(claims({ token_type: "preauth" })),
    );

    expect(response.status).toBe(401);
    expect(evaluatedIdentity).toBeUndefined();
  });

  it("403s when the token is good but the permission is not held", async () => {
    allowed = false;
    evaluatedIdentity = undefined;

    // A different subject from the allowed case: grant roots are cached per
    // identity, so reusing one would answer from the warm entry and never test
    // the denial at all.
    const response = await call(
      await signer.sign(claims({ sub: "idn_denied" })),
    );

    // Authenticated, so past the first guard; denied by the second.
    expect(response.status).toBe(403);
    expect(evaluatedIdentity).toBe("idn_denied");

    allowed = true;
  });
});
