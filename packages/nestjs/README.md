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
      resolveIdentity: (request) => request.user?.sub,
      resolveNode: (request) => request.params?.orgId,
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
    resolveIdentity: (request) => request.user?.sub,
    resolveNode: (request) => request.params?.orgId,
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

A route with no `@RequirePermission` passes through untouched, so the guard can be registered globally and opted into per route. A requirement on a handler wins over one on its controller.

### If you register it globally

Nest runs global guards **before** controller- and route-scoped ones. So a globally-registered `CanopyGuard` runs before a route-level `AuthGuard` has put anything on the request, and `resolveIdentity` finds nothing — every guarded route answers `403`.

Register your authentication guard globally too, ahead of this one:

```ts
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard }, // must come first
  { provide: APP_GUARD, useClass: CanopyGuard },
];
```

Global guards run in registration order. If your authentication is route-level, apply `CanopyGuard` at the route as well — `@UseGuards(JwtAuthGuard, CanopyGuard)` — where left-to-right order holds.

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

- no identity resolves, including when a resolver throws on an unauthenticated request — `403`
- a `node` check with no node, or with no `resolveNode` configured — `403`
- Canopy answers `allowed: false` — `403`
- Canopy has never heard of the identity (`404`) — `403`
- Canopy cannot be reached, or is rate-limiting, or answers `5xx` — `503`, deliberately not `403`, because "we could not decide" is not "you are not allowed"
- Canopy rejects the API key (`401`/`403`), or refuses the question (other `4xx`) — `500`, because a misconfiguration is not a temporary condition and no retry will fix it
- the caller hung up mid-check — the abort is propagated, not turned into a `503`, because nothing failed and no one is waiting for an answer

Everything except the caller hanging up is logged with its cause before the request is refused.

The `500` cases are worth alerting on: they mean the integration is broken rather than the service being slow. Reporting them as `503` would bury a bad API key under what looks like an outage.

## Bounding the check

The check runs on the request path, so an unanswered one is an inbound request held open. Two things bound it.

**A bounded wait.** The guard evaluates with a 5s per-attempt deadline rather than the client-wide 30s, and 1 retry rather than 2 — both sized for a call on the request path rather than for administrative CRUD. Change either if your own budget differs:

```ts
CanopyModule.forRoot({
  apiKey: process.env.CANOPY_API_KEY,
  evaluateTimeoutMs: 2_000,
  evaluateMaxRetries: 0,
  resolveIdentity: (request) => request.user?.sub,
});
```

These multiply. A deadline alone would still permit `evaluateMaxRetries + 1` attempts back to back, and the waiting _between_ attempts is set by Canopy's `Retry-After` — a header, which without a cap could hold the request far longer than any deadline. The guard therefore also caps each wait at one `evaluateTimeoutMs`.

Worst case is roughly `evaluateTimeoutMs × (2 × evaluateMaxRetries + 1)`: about 15s with the defaults, against an unbounded wait before.

Both apply to the guard alone. Everything else you do through the injected client keeps the client-wide `timeoutMs` and `maxRetries`.

**Hanging up when the caller does.** If the client disconnects while the check is in flight, the guard aborts it rather than finishing a decision no one will read. It watches the response for a close that arrives before anything was written.

This works on both Express, where Nest returns the Node response directly, and Fastify, where the real response is on `reply.raw`. A transport with neither — GraphQL, or a microservice context — simply runs to the deadline.

## License

MIT © Canopy Identity Inc.
