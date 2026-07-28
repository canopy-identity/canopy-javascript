# @canopy-io/nestjs

Official NestJS integration for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

Turns a permission check into a decorator on the route instead of a call in every handler.

## Install

```bash
npm install @canopy-io/nestjs
```

Requires NestJS 10 or 11 and Node 18 or later. `@canopy-io/node` comes with it.

## Register

```ts
import { CanopyModule } from "@canopy-io/nestjs";

@Module({
  imports: [
    CanopyModule.forRoot<AuthedRequest>({
      apiKey: process.env.CANOPY_API_KEY,
      resolveIdentity: (request) => request.user.sub,
      resolveNode: (request) => request.params.orgId,
    }),
  ],
})
export class AppModule {}
```

The two resolvers are how the guard learns _who_ is asking and _where_. Where those live is your application's business — a claim on a verified token, a route parameter, a tenant on the session — so you supply them rather than the library guessing. Pass your own request type to `forRoot` and both resolvers are typed against it.

When the key comes from something injectable, use `forRootAsync`:

```ts
CanopyModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    apiKey: config.getOrThrow("CANOPY_API_KEY"),
    resolveIdentity: (request) => request.user.sub,
    resolveNode: (request) => request.params.orgId,
  }),
});
```

## Guard a route

```ts
import { CanopyGuard, RequirePermission } from "@canopy-io/nestjs";

@Controller("orgs/:orgId/orders")
@UseGuards(CanopyGuard)
export class OrdersController {
  @Post(":orderId/refund")
  @RequirePermission("orders.refund")
  refund() {}
}
```

That asks Canopy whether the identity holds `orders.refund` **at** `orgId`, walking the node's lineage — so a role granted on a parent is inherited without you modelling it.

A route with no `@RequirePermission` passes through untouched, so the guard is safe to register globally and opt into per route. A requirement on a handler wins over one on its controller.

### Scope

The default is `node`, which is the strict question: does this identity hold the permission _at this node_.

```ts
@RequirePermission("reports.view", { scope: "app_wide" })
```

`app_wide` asks only whether the identity holds the permission anywhere in the Environment, and returns no effective node. It is right for deciding whether to show a menu item and wrong for guarding a resource that belongs to a node — which is why it is opt-in rather than the default.

## The client

For anything the guard does not cover, inject the client:

```ts
import { InjectCanopy, type Canopy } from "@canopy-io/nestjs";

@Injectable()
export class OrdersService {
  constructor(@InjectCanopy() private readonly canopy: Canopy) {}

  async assign(identityId: string, nodeId: string, roleId: string) {
    await this.canopy.assignments.create({
      identity_id: identityId,
      node_id: nodeId,
      role_id: roleId,
    });
  }
}
```

It is the same [`@canopy-io/node`](../node) client, with its retry policy, pagination and typed errors.

## Failing closed

There is no path through `CanopyGuard` that allows a request whose decision is unknown. Each of these ends the request:

- no identity resolves — `403`
- a `node` check with no node, or with no `resolveNode` configured — `403`
- Canopy answers `allowed: false` — `403`
- Canopy cannot be reached — `503`, deliberately not `403`, because "we could not decide" is not "you are not allowed"

The unreachable case is logged with its cause before the request is refused.

## License

MIT © Canopy Identity Inc.
