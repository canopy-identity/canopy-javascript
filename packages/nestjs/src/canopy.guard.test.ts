import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import type { Canopy } from "@canopy-io/node";

import { CanopyGuard } from "./canopy.guard.js";
import type { CanopyModuleOptions } from "./options.js";
import type { PermissionRequirement } from "./require-permission.decorator.js";

/**
 * Every test here is really one question: can a request reach the handler
 * without Canopy having said yes? The guard is the only thing standing between
 * a route and its data, so the cases that matter are the failures — no
 * identity, no node, an unreachable API — not the happy path.
 */

interface FakeRequest {
  user?: { sub?: string };
  params?: { nodeId?: string };
}

/**
 * A stand-in for the Node response the guard watches for a disconnect. `close`
 * is emitted by hand so a test can hang up mid-check.
 */
function fakeResponse() {
  const listeners = new Map<string, () => void>();

  return {
    writableEnded: false,
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
    },
    removeListener(event: string) {
      listeners.delete(event);
    },
    /** Simulate the client going away. */
    emitClose() {
      listeners.get("close")?.();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/**
 * What Nest hands back under Fastify: a `Reply`, which is a plain object rather
 * than an EventEmitter, with the real Node response on `.raw`. Nothing here
 * listens, so a guard that tests the outer object never arms.
 */
function fastifyReply(raw: ReturnType<typeof fakeResponse>) {
  return { raw, send: () => undefined, code: () => undefined };
}

function harness(config: {
  requirement?: PermissionRequirement;
  request?: FakeRequest;
  evaluate?: (
    query: unknown,
    options?: {
      timeoutMs?: number;
      maxRetries?: number;
      maxBackoffMs?: number;
      signal?: AbortSignal;
    },
  ) => Promise<{ allowed: boolean }>;
  /** Omit the node resolver entirely, as an application that never set one. */
  withoutNodeResolver?: boolean;
  evaluateTimeoutMs?: number;
  evaluateMaxRetries?: number;
  /** Either a bare Node response (Express) or a Fastify-shaped wrapper. */
  response?: ReturnType<typeof fakeResponse> | ReturnType<typeof fastifyReply>;
  /** Reach into the request the way the docs suggest, and let it throw. */
  throwingIdentityResolver?: boolean;
  throwingNodeResolver?: boolean;
}) {
  const evaluate = vi.fn(
    config.evaluate ?? (() => Promise.resolve({ allowed: true })),
  );

  const canopy = {
    permissions: { evaluate },
  } as unknown as Canopy;

  const reflector = {
    getAllAndOverride: () => config.requirement,
  } as unknown as Reflector;

  const options: CanopyModuleOptions<unknown> = {
    apiKey: "cnpy_test",
    resolveIdentity: config.throwingIdentityResolver
      ? // The exact expression the README shows, which throws when unauthenticated.
        (request: unknown) => (request as { user: { sub: string } }).user.sub
      : (request: unknown) => (request as FakeRequest).user?.sub ?? null,
    ...(config.withoutNodeResolver
      ? {}
      : {
          resolveNode: config.throwingNodeResolver
            ? (request: unknown) =>
                (request as { params: { nodeId: string } }).params.nodeId
            : (request: unknown) =>
                (request as FakeRequest).params?.nodeId ?? null,
        }),
    ...(config.evaluateTimeoutMs === undefined
      ? {}
      : { evaluateTimeoutMs: config.evaluateTimeoutMs }),
    ...(config.evaluateMaxRetries === undefined
      ? {}
      : { evaluateMaxRetries: config.evaluateMaxRetries }),
  };

  const guard = new CanopyGuard(reflector, canopy, options);

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => config.request ?? {},
      getResponse: () => config.response,
    }),
  } as unknown as Parameters<CanopyGuard["canActivate"]>[0];

  return { guard, context, evaluate };
}

const NODE_REQUIREMENT: PermissionRequirement = {
  permission: "orders.refund",
  scope: "node",
};

describe("routes without a requirement", () => {
  it("lets an undecorated route through without calling Canopy", async () => {
    const { guard, context, evaluate } = harness({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("resolving the request", () => {
  it("allows when Canopy allows", async () => {
    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("asks the question the decorator recorded", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
    });

    await guard.canActivate(context);

    // The first argument is the question; the second is call options, asserted
    // separately in "bounding the call".
    expect(evaluate.mock.calls[0]?.[0]).toEqual({
      identity_id: "idn_1",
      permission: "orders.refund",
      scope: "node",
      node_id: "nod_1",
    });
  });

  it("omits node_id entirely on an app_wide check", async () => {
    const { guard, context, evaluate } = harness({
      requirement: { permission: "reports.view", scope: "app_wide" },
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[0]).toEqual({
      identity_id: "idn_1",
      permission: "reports.view",
      scope: "app_wide",
    });
  });
});

describe("failing closed", () => {
  it("denies when Canopy denies", async () => {
    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
      evaluate: () => Promise.resolve({ allowed: false }),
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("denies when no identity resolves, without asking Canopy", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: { params: { nodeId: "nod_1" } },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("denies a node check when no node resolves", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" } },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("denies a node check when resolveNode was never configured", async () => {
    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
      withoutNodeResolver: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  /**
   * The case that matters most. If Canopy is unreachable the request must not
   * proceed, and the failure must not read as a policy denial — a 503 says the
   * decision is unknown, which is the truth.
   */
  it("denies with 503, not 403, when Canopy cannot be reached", async () => {
    // The guard logs the cause before failing closed, which is wanted in
    // production and only noise here.
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } },
      evaluate: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("treats an empty-string identity as no identity", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "" }, params: { nodeId: "nod_1" } },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});

/**
 * Every branch here denies. What differs is what it *says* — and reporting a
 * rejected API key as "temporarily unavailable" invites a retry that will never
 * work while hiding the misconfiguration behind an apparent outage.
 */
describe("reporting why a check failed", () => {
  const REQUEST = { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } };

  function canopyError(statusCode: number, code: string | null = null) {
    return Object.assign(new Error(`canopy said ${statusCode}`), {
      name: "CanopyError",
      statusCode,
      code,
      isAuthFailure: statusCode === 401 || statusCode === 403,
      isRateLimited: statusCode === 429,
    });
  }

  function failWith(error: Error) {
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      evaluate: () => Promise.reject(error),
    });

    return {
      run: () => guard.canActivate(context).catch((e: unknown) => e),
      logged,
    };
  }

  /** A rejected credential is a permanent misconfiguration, not an outage. */
  it("reports a rejected API key as a server error, not 503", async () => {
    const { run, logged } = failWith(canopyError(401));

    const error = await run();

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error).not.toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toMatch(/misconfigured/i);
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("reports a forbidden API key as a server error too", async () => {
    const { run, logged } = failWith(canopyError(403));

    expect(await run()).toBeInstanceOf(InternalServerErrorException);

    logged.mockRestore();
  });

  /** An identity Canopy has never heard of is a decision: deny. */
  it("denies when the identity is unknown to Canopy", async () => {
    const { run, logged } = failWith(canopyError(404));

    expect(await run()).toBeInstanceOf(ForbiddenException);

    logged.mockRestore();
  });

  it("reports a Canopy 5xx as temporarily unavailable", async () => {
    const { run, logged } = failWith(canopyError(503));

    expect(await run()).toBeInstanceOf(ServiceUnavailableException);

    logged.mockRestore();
  });

  it("reports a rate limit as temporarily unavailable", async () => {
    const { run, logged } = failWith(canopyError(429));

    expect(await run()).toBeInstanceOf(ServiceUnavailableException);

    logged.mockRestore();
  });

  /** A question Canopy rejected is our bug, and no retry fixes it. */
  it("reports a malformed question as a server error", async () => {
    const { run, logged } = failWith(canopyError(400));

    expect(await run()).toBeInstanceOf(InternalServerErrorException);

    logged.mockRestore();
  });

  it("still reports an unreachable Canopy as temporarily unavailable", async () => {
    const { run, logged } = failWith(new Error("ECONNREFUSED"));

    expect(await run()).toBeInstanceOf(ServiceUnavailableException);

    logged.mockRestore();
  });
});

/**
 * `request.user.sub` is the shape the docs suggest, and it throws on an
 * unauthenticated request. That must deny, not crash — especially since a
 * globally-registered guard runs before route-level authentication.
 */
describe("a resolver that throws", () => {
  it("denies with 403 rather than surfacing a 500", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      // No `user` at all: `request.user.sub` throws a TypeError.
      request: {},
      throwingIdentityResolver: true,
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("denies when the node resolver throws", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: { user: { sub: "idn_1" } },
      throwingNodeResolver: true,
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

/**
 * The check sits on the request path, so an unanswered one is a request held
 * open. These pin the two things that bound it: a deadline far tighter than the
 * client-wide default, and hanging up when the caller already has.
 */
describe("bounding the call", () => {
  const REQUEST = { user: { sub: "idn_1" }, params: { nodeId: "nod_1" } };

  it("applies a 5s deadline rather than the client-wide 30s", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.timeoutMs).toBe(5_000);
  });

  it("honours a configured evaluateTimeoutMs", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      evaluateTimeoutMs: 750,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.timeoutMs).toBe(750);
  });

  /**
   * The deadline alone would not bound the wait — the client would still take
   * `maxRetries + 1` of them. Capping attempts is what makes the ceiling real.
   */
  it("caps attempts below the client-wide default", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.maxRetries).toBe(1);
  });

  /**
   * The wait between attempts is set by Canopy's `Retry-After` and sits outside
   * the deadline. Uncapped, a 429 could hold the inbound request for as long as
   * that header says — making the stated ceiling meaningless.
   */
  it("caps the wait between attempts at one deadline", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.maxBackoffMs).toBe(5_000);
  });

  it("scales the backoff cap with a configured deadline", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      evaluateTimeoutMs: 750,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.maxBackoffMs).toBe(750);
  });

  it("honours a configured evaluateMaxRetries", async () => {
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      evaluateMaxRetries: 0,
    });

    await guard.canActivate(context);

    expect(evaluate.mock.calls[0]?.[1]?.maxRetries).toBe(0);
  });

  /**
   * The regression that would matter most: a request stream emits `close` on
   * every normal request, so watching the wrong object would abort healthy
   * checks. Nothing is aborted while the response is still open.
   */
  it("does not abort a healthy request", async () => {
    const response = fakeResponse();
    const { guard, context, evaluate } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(evaluate.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  /**
   * Fastify's Reply is not an EventEmitter, so a guard that tests the outer
   * object and returns early never attaches anything — and a hung-up client
   * waits out the whole budget on the adapter the comment claimed to support.
   */
  it("arms on Fastify, where the stream is on reply.raw", async () => {
    const raw = fakeResponse();
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response: fastifyReply(raw),
      evaluate: (_query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason as Error);
          });
          raw.emitClose();
        }),
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect((error as Error).name).toBe("AbortError");
    expect(logged).not.toHaveBeenCalled();

    logged.mockRestore();
  });

  it("attaches to reply.raw for the duration, then removes it", async () => {
    const raw = fakeResponse();
    let attachedDuringCall = 0;

    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response: fastifyReply(raw),
      evaluate: () => {
        // Counting only after the fact would pass even if nothing ever
        // attached, which is exactly the bug this covers.
        attachedDuringCall = raw.listenerCount;

        return Promise.resolve({ allowed: true });
      },
    });

    await guard.canActivate(context);

    expect(attachedDuringCall).toBe(1);
    expect(raw.listenerCount).toBe(0);
  });

  it("removes its listener once the check is done", async () => {
    const response = fakeResponse();
    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response,
    });

    await guard.canActivate(context);

    expect(response.listenerCount).toBe(0);
  });

  /** A caller hanging up is not Canopy failing, so it must not become a 503. */
  it("propagates the abort instead of reporting 503 when the caller hangs up", async () => {
    const response = fakeResponse();
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response,
      // Listens before the disconnect, as fetch does.
      evaluate: (_query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason as Error);
          });
          response.emitClose();
        }),
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ServiceUnavailableException);
    // Nothing failed on Canopy's side, so nothing should be logged as if it had.
    expect(logged).not.toHaveBeenCalled();

    logged.mockRestore();
  });

  /** A response that already finished is not a disconnect. */
  it("ignores close once the response has been written", async () => {
    const response = fakeResponse();
    const { guard, context } = harness({
      requirement: NODE_REQUIREMENT,
      request: REQUEST,
      response,
      evaluate: (_query, options) => {
        response.writableEnded = true;
        response.emitClose();

        return Promise.resolve({ allowed: !options?.signal?.aborted });
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
