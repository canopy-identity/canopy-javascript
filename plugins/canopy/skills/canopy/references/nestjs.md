# NestJS: @canopy-io/nestjs

```bash
npm install @canopy-io/nestjs
```

Requires NestJS 10 or 11. `@canopy-io/node` comes with it.

## Register the module

Register it once, in the root module, with `isGlobal: true`. Guarded controllers usually live in feature modules, and the guards there resolve the module's providers only when it is global; without it the application refuses to start.

`verify` is required: the module builds a `TokenVerifier` at startup. Name the Environment (`environmentId`), or `issuer` on a custom auth domain or self-hosted instance. A backend that reaches Canopy at a different address than the one its tokens name passes `issuer` as the token's `iss` reads plus `jwksUri` at the address it can reach ([node.md](node.md)). For Hosted Login, add `audience`, your OAuth `client_id`; for the Direct API, leave it out.

```ts
import { Module } from "@nestjs/common";
import { CanopyModule } from "@canopy-io/nestjs";

interface AuthedRequest {
  canopyToken?: { sub: string };
  params?: Record<string, string>;
}

@Module({
  imports: [
    CanopyModule.forRoot<AuthedRequest>({
      // Guards in every feature module resolve from this one registration.
      isGlobal: true,
      apiKey: process.env.CANOPY_API_KEY,
      verify: {
        environmentId: process.env.CANOPY_ENVIRONMENT_ID ?? "",
        // Hosted Login: your OAuth client id. Direct API: leave this out.
        audience: process.env.CANOPY_OAUTH_CLIENT_ID,
      },
      resolveIdentity: (request) => request.canopyToken?.sub,
      resolveNode: (request) => request.params?.["nodeId"],
    }),
  ],
})
export class AppModule {}
```

When configuration is injectable, use `forRootAsync`:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CanopyModule } from "@canopy-io/nestjs";

interface AuthedRequest {
  canopyToken?: { sub: string };
  params?: Record<string, string>;
}

@Module({
  imports: [
    CanopyModule.forRootAsync<AuthedRequest>({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        apiKey: config.getOrThrow<string>("CANOPY_API_KEY"),
        verify: {
          environmentId: config.getOrThrow<string>("CANOPY_ENVIRONMENT_ID"),
        },
        resolveIdentity: (request) => request.canopyToken?.sub,
        resolveNode: (request) => request.params?.["nodeId"],
      }),
    }),
  ],
})
export class AppModule {}
```

The two resolvers tell the guard **who** is asking and **where**. Take both from trusted sources: the identity from a verified token, the node from the route or from your own records, never from a header the caller sets freely.

## Guard routes

If Canopy issues the application's tokens and there is no auth layer yet, `CanopyTokenGuard` is that layer: it verifies the bearer token locally and puts the claims on `request.canopyToken`. **Order matters**: it must run before `CanopyGuard`.

```ts
import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  CanopyGuard,
  CanopyTokenGuard,
  RequirePermission,
} from "@canopy-io/nestjs";

@Controller("nodes/:nodeId/reports")
@UseGuards(CanopyTokenGuard, CanopyGuard)
export class ReportsController {
  // Does the identity hold reports.view at :nodeId, or above it?
  @Get()
  @RequirePermission("reports.view")
  list() {
    return [];
  }

  @Post(":reportId/publish")
  @RequirePermission("reports.publish")
  publish() {
    return { published: true };
  }

  // Anywhere in the Environment: for showing a menu item, never for a
  // resource that belongs to a node.
  @Get("menu")
  @RequirePermission("reports.view", { scope: "app_wide" })
  menu() {
    return { showReports: true };
  }
}
```

- A route without `@RequirePermission` passes through `CanopyGuard`. A requirement on a handler wins over one on its controller.
- Already running Passport or your own JWT middleware? Skip `CanopyTokenGuard`, and point `resolveIdentity` at where your layer puts the verified subject.
- Registering `CanopyGuard` globally: register the authentication guard globally too, **before** it, or every route answers `403`. Global guards run in registration order.
- `scope: "org"`: for Environments with organizations on. The guard evaluates at the `org_id` on the verified token; no `resolveNode` needed. A token with no `org_id` is denied, staff included: staff (`org_scope: "all"`) enter an organization with `switch-organization` first, and the guard never takes it from the route. See [access-models.md](access-models.md).

### Routes that machines call

A machine client's `client_credentials` token (`type: "service"`) answers `401` from `CanopyTokenGuard` unless the route or controller carries `@AllowServiceTokens()`, and the module's `verify.serviceAudience` names the audience the API answers to (the token's `aud`). There `CanopyGuard` evaluates the client's own grants, chosen from the verified claims; `resolveIdentity: (request) => request.canopyToken?.sub` serves both kinds, because a service token's `sub` is the client's `client_id`.

```ts
import { Controller, Post, UseGuards } from "@nestjs/common";
import {
  AllowServiceTokens,
  CanopyGuard,
  CanopyTokenGuard,
  RequirePermission,
} from "@canopy-io/nestjs";

@Controller("imports")
@UseGuards(CanopyTokenGuard, CanopyGuard)
@AllowServiceTokens()
export class ImportsController {
  // A machine client pinned to an organization acts in its org_id.
  @Post("orders")
  @RequirePermission("orders.import", { scope: "org" })
  importOrders() {
    return { accepted: true };
  }
}
```

- Put `@AllowServiceTokens()` only on routes built for machines. Read `request.canopyToken.type` in the handler when people and machines should be treated differently.

### Routes an agent calls for a person

A machine client acting for a person presents a `delegated` token (see [node.md](node.md), "Acting for a person"). `CanopyTokenGuard` refuses it unless the route or controller carries `@AllowDelegatedTokens()`, held to `verify.serviceAudience` like a service token. There `CanopyGuard` evaluates the person (`resolveIdentity` still reads `sub`) and the client in `act.sub` at the same node, and allows only when both hold the permission.

```ts
import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  AllowDelegatedTokens,
  CanopyGuard,
  CanopyTokenGuard,
  RequirePermission,
} from "@canopy-io/nestjs";

@Controller("deals")
@UseGuards(CanopyTokenGuard, CanopyGuard)
export class DealsController {
  // A person, or an agent acting for one: both must hold deals.read here.
  @Get()
  @AllowDelegatedTokens()
  @RequirePermission("deals.read", { scope: "org" })
  list() {
    return [];
  }
}
```

- Put `@AllowDelegatedTokens()` only where an agent may act for someone. Read `request.canopyToken.act?.sub` to record which client acted.

### Reading a custom claim

An Environment can map facts of its own onto the token (Console: Tenant → Authentication → Custom claims): a `plan` from the identity's metadata, say. `CanopyTokenRequest<TCustom>` types the request `CanopyTokenGuard` attached the claims to, with the custom claims named and optional: one that is not stored, or did not fit (`custom_claims_overflow`), is absent, which is "not set", never a pass.

```ts
import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  UseGuards,
} from "@nestjs/common";
import { CanopyTokenGuard, type CanopyTokenRequest } from "@canopy-io/nestjs";

interface PlanClaims {
  plan?: "free" | "pro";
}

@Controller("exports")
@UseGuards(CanopyTokenGuard)
export class ExportsController {
  @Get("quarterly")
  quarterly(@Req() request: CanopyTokenRequest<PlanClaims>) {
    if (request.canopyToken?.plan !== "pro") {
      throw new ForbiddenException("The quarterly export needs the Pro plan.");
    }

    return { rows: [] };
  }
}
```

## What each status means

`CanopyGuard` never lets an undecided request through:

- `403`: no identity, no node for a `node` check, the permission is not held on the node's lineage, or the identity is unknown to Canopy.
- `503`: Canopy could not be reached, rate-limited the read, or answered `5xx`. Nothing was decided. Do not map it to `403`.
- `500`: the API key was rejected, a scoped key lacks `identity.view` or `hierarchy.view`, or the node is not in the hierarchy the key can read. The integration is broken; alert on it.
- `CanopyTokenGuard`: `401` for any rejected token (the reason is on `error.cause`, for logs), `503` when the signing keys cannot be fetched.

Answers are cached for at most 60 seconds (`authorizationTtlMs`, up to 300 000). That is how long a revoked permission can keep working. For one high-value operation, ask the API directly:

```ts
import { Injectable } from "@nestjs/common";
import { InjectCanopy, type Canopy } from "@canopy-io/nestjs";

@Injectable()
export class PaymentsService {
  constructor(@InjectCanopy() private readonly canopy: Canopy) {}

  async mayRelease(identityId: string, nodeId: string): Promise<boolean> {
    const { allowed } = await this.canopy.permissions.evaluate({
      identity_id: identityId,
      permission: "payments.release",
      scope: "node",
      node_id: nodeId,
    });

    return allowed;
  }
}
```

## The API key

A `full_access` key needs nothing more. A **scoped** key must list `identity.view` (grant roots) and `hierarchy.view` (the hierarchy). Without `hierarchy.view` the tree reads as empty and node checks fail with `500`, not a silent `403`.
