import {
  ForbiddenException,
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

function harness(config: {
  requirement?: PermissionRequirement;
  request?: FakeRequest;
  evaluate?: () => Promise<{ allowed: boolean }>;
  /** Omit the node resolver entirely, as an application that never set one. */
  withoutNodeResolver?: boolean;
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
    resolveIdentity: (request: unknown) =>
      (request as FakeRequest).user?.sub ?? null,
    ...(config.withoutNodeResolver
      ? {}
      : {
          resolveNode: (request: unknown) =>
            (request as FakeRequest).params?.nodeId ?? null,
        }),
  };

  const guard = new CanopyGuard(reflector, canopy, options);

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => config.request ?? {},
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

    expect(evaluate).toHaveBeenCalledWith({
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

    expect(evaluate).toHaveBeenCalledWith({
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
