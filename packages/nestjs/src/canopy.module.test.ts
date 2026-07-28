import { Controller, Get, Injectable, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { Canopy } from "@canopy-io/node";

import { CanopyGuard } from "./canopy.guard.js";
import { CanopyModule } from "./canopy.module.js";
import { InjectCanopy } from "./inject-canopy.decorator.js";
import { RequirePermission } from "./require-permission.decorator.js";
import { CANOPY_CLIENT, CANOPY_PERMISSION } from "./tokens.js";

/**
 * These assert the wiring rather than the policy: that Nest can actually build
 * the graph this module describes. It is worth testing because the package is
 * bundled with esbuild, which emits no `design:paramtypes` — so an injection
 * that relied on constructor types would compile, pass every unit test, and
 * then fail at application boot.
 */

const OPTIONS = {
  apiKey: "cnpy_test",
  resolveIdentity: () => "idn_1",
  resolveNode: () => "nod_1",
};

describe("forRoot", () => {
  it("provides a usable client", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CanopyModule.forRoot(OPTIONS)],
    }).compile();

    const canopy = moduleRef.get<Canopy>(CANOPY_CLIENT);

    expect(canopy).toBeInstanceOf(Canopy);
    expect(typeof canopy.permissions.evaluate).toBe("function");
  });

  /** The guard's three dependencies must all resolve by token. */
  it("constructs the guard", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CanopyModule.forRoot(OPTIONS)],
    }).compile();

    expect(moduleRef.get(CanopyGuard)).toBeInstanceOf(CanopyGuard);
  });

  it("injects the client into a consumer service", async () => {
    @Injectable()
    class OrdersService {
      constructor(@InjectCanopy() readonly canopy: Canopy) {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [CanopyModule.forRoot(OPTIONS)],
      providers: [OrdersService],
    }).compile();

    expect(moduleRef.get(OrdersService).canopy).toBeInstanceOf(Canopy);
  });

  it("is not global unless asked", () => {
    const notGlobal = CanopyModule.forRoot(OPTIONS);
    const global = CanopyModule.forRoot({ ...OPTIONS, isGlobal: true });

    expect(notGlobal.global).toBe(false);
    expect(global.global).toBe(true);
  });
});

describe("forRootAsync", () => {
  it("builds the client from an async factory", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CanopyModule.forRootAsync({
          useFactory: () => Promise.resolve(OPTIONS),
        }),
      ],
    }).compile();

    expect(moduleRef.get<Canopy>(CANOPY_CLIENT)).toBeInstanceOf(Canopy);
  });
});

describe("@RequirePermission", () => {
  it("records the permission and defaults the scope to node", () => {
    class Controller1 {
      @RequirePermission("orders.refund")
      refund(this: void) {}
    }

    expect(
      Reflect.getMetadata(CANOPY_PERMISSION, Controller1.prototype.refund),
    ).toEqual({ permission: "orders.refund", scope: "node" });
  });

  it("records an explicit app_wide scope", () => {
    class Controller2 {
      @RequirePermission("reports.view", { scope: "app_wide" })
      view(this: void) {}
    }

    expect(
      Reflect.getMetadata(CANOPY_PERMISSION, Controller2.prototype.view),
    ).toEqual({ permission: "reports.view", scope: "app_wide" });
  });

  it("applies to a whole controller", () => {
    @Controller()
    @RequirePermission("orders.read")
    @UseGuards(CanopyGuard)
    class Orders {
      @Get()
      list() {}
    }

    expect(Reflect.getMetadata(CANOPY_PERMISSION, Orders)).toEqual({
      permission: "orders.read",
      scope: "node",
    });
  });
});
