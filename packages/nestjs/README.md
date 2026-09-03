# @canopy-io/nestjs

Official NestJS integration for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

Turns a permission check into a decorator on the route instead of a call in every handler.

## Install

```bash
npm install @canopy-io/nestjs
```

Requires NestJS 10 or 11 and Node 18 or later. `@canopy-io/node` comes with it.

## Features

- **One registration.** `CanopyModule.forRoot` for a static key, `forRootAsync` when it comes from something injectable. Pass your own request type and the resolvers are typed against it.
- **`@RequirePermission` on the route.** The check is a declaration on the handler rather than a call inside it. A route without it passes through untouched, so the guard can be registered globally and opted into.
- **`CanopyGuard`** answers that declaration **in your own process**, at the node the request names — inheriting a role granted on a parent without you modelling the walk.
- **No network call per request.** The guard holds the identity's grant roots and one shared copy of your hierarchy, refreshed at most once a minute, so a guarded route normally reaches no network at all.
- **Three scopes.** `node` is the default and the strict question; `app_wide` asks only whether the identity holds the permission anywhere in the Environment; `org` asks the node question at the organization the caller's token is acting in.
- **`CanopyTokenGuard`** verifies a Canopy-issued bearer token locally against the published signing keys and attaches the claims, for applications with no auth layer in front. Additive — skip it if you already run Passport or your own JWT middleware.
- **`@InjectCanopy()`** hands you the full `@canopy-io/node` client for everything the guard does not cover.
- **Fails closed, with the status telling you which failure it was.** `403` for a denial, `503` for an undecidable one, `500` for a broken integration.
- **A bounded check.** Its own evaluation timeout and retry count, separate from the client-wide ones, with the wait between attempts capped.
- **Aborts when the caller hangs up**, on both Express and Fastify, rather than finishing a decision no one will read.

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

That answers whether the identity holds `orders.refund` **at** `orgId`, walking the node's lineage — so a role granted on a parent is inherited without you modelling it.

The walk happens in your process, not over the network. See [How the decision is reached](#how-the-decision-is-reached).

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

```ts
@RequirePermission("invoices.view", { scope: "org" })
```

`org` is for Environments running the **organizations** access model, where a
token carries the organization the session is acting in (`org_id`) and the one
role held there (`org_role`). The guard reads `org_id` off the verified claims
`CanopyTokenGuard` attached and evaluates at that node — an organization _is_ a
hierarchy node, and a membership is a role assignment at it, so no `resolveNode`
and no node in the route's path are needed. A caller acting in no organization
is denied: an org-scoped route has no meaning outside one.

If your own auth layer verifies tokens and parks the claims somewhere other
than `attachTokenAs`, configure `resolveOrg` — and feed it only a value read
off a _verified_ token, because it decides which organization's grants answer
the check.

## If Canopy issues your tokens

`resolveIdentity` assumes something upstream already verified the caller. If
you have no auth layer yet, `CanopyTokenGuard` is that layer: it verifies the
bearer token against Canopy's published signing keys and attaches the claims,
so `resolveIdentity` has something trustworthy to read.

```ts
CanopyModule.forRoot<AuthedRequest>({
  apiKey: process.env.CANOPY_API_KEY,
  verify: { audience: process.env.CANOPY_OAUTH_CLIENT_ID }, // omit for Direct API
  resolveIdentity: (request) => request.canopyToken?.sub,
});
```

```ts
@UseGuards(CanopyTokenGuard, CanopyGuard)
@RequirePermission("documents.read")
findAll() {}
```

**Order matters.** Nest runs guards left to right, and `CanopyGuard` reads what
`CanopyTokenGuard` attaches. Reversed, every request is denied — the identity
is resolved before anything has established one.

Verification is local: one fetch of the key set, then a signature check per
request with no network at all.

A rejected token is a 401 whatever the detail, with the specific code left on
`error.cause` for your logs rather than handed to the caller — who has no use
for the difference and should not be told which check failed. The exception is
`token.jwks_unavailable`, which answers **503**: not being able to verify is not
the same as failing to verify, the caller's token may be perfectly good, and
telling a client its token is stale during a key-server outage only aims a
refresh storm at the thing that is already down.

Claims land on `request.canopyToken`, not `request.user` — that one belongs to
Passport, and quietly overwriting it would be somebody's difficult afternoon.
Use `attachTokenAs` to put them elsewhere.

Skip this guard entirely if you already run Passport or your own JWT
middleware. It is additive; nothing else in the package depends on it.

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
- the identity holds the permission nowhere, or nowhere on this node's lineage — `403`
- Canopy has never heard of the identity (`404`) — `403`
- a cache miss cannot be filled because Canopy is unreachable, rate-limiting, or answers `5xx` — `503`, deliberately not `403`, because "we could not decide" is not "you are not allowed"
- Canopy rejects the API key (`401`/`403`), or refuses the read (other `4xx`) — `500`, because a misconfiguration is not a temporary condition and no retry will fix it
- the hierarchy this credential can read does not contain the node — `500`, naming the cause. Undecidable, not denied: answering `403` would take out every node-scoped route while looking like ordinary policy
- the caller hung up mid-check — the abort is propagated, not turned into a `503`, because nothing failed and no one is waiting for an answer

A held answer is never served past its window to paper over an outage. Once it expires, an unfillable read is a `503` — extending it silently would extend the revocation window with it, without anyone choosing to.

Everything except the caller hanging up is logged with its cause before the request is refused.

The `500` cases are worth alerting on: they mean the integration is broken rather than the service being slow. Reporting them as `503` would bury a bad API key under what looks like an outage.

## How the decision is reached

The guard does not ask Canopy per request. It asks a different question, once, and answers every later check from the result.

Rather than "may this identity act **here**", it reads "**where** may this identity act" — the nodes each permission was granted at. Those grant roots are not expanded through their descendants, because a grant already means _this node and everything beneath it_; expanding would restate your hierarchy once per identity, and would be largest for the near-root grants your administrators hold.

So two things are held, split by what they depend on:

- **grant roots, per identity** — small, a handful of assignments
- **your hierarchy, once per process** — shared by every identity, since its shape does not depend on who is asking

and a check is a walk up from the node in question looking for a grant root. An `app_wide` check is simpler still: the permission appearing at all is the answer, and no hierarchy is needed.

**Both are held for at most 60 seconds**, which is therefore the delay between an access change and it taking effect. The hierarchy is revalidated rather than re-read — a conditional request that normally answers `304`, so nothing transfers.

```ts
CanopyModule.forRoot({
  apiKey: process.env.CANOPY_API_KEY,
  authorizationTtlMs: 30_000,
  resolveIdentity: (request) => request.user?.sub,
});
```

Shortening that window makes revocation take effect sooner and costs more calls. Below the gap between a user's requests it stops saving anything at all — every request finds the cache expired and refetches, which is the per-request traffic this exists to remove. Human-paced traffic has multi-second gaps, so a few seconds can cost full price for no benefit.

### What the credential needs

A `full_access` API key needs nothing further. A **scoped** key must carry both
of the permissions the guard reads with, because a scoped key is granted
exactly the permission keys listed on it:

- **`identity.view`** — to read an identity's grant roots.
- **`hierarchy.view`** — to read the hierarchy the walk runs against, taken as parent edges (`GET /api/v1/nodes/parents`) rather than the dashboard's tree.

Miss the first and every guarded route answers `500` naming the failed read.
Miss the second and the tree comes back **empty with a `200`** — the API is
answering "here is everything you may see", which is nothing. The guard does
not treat that as an absence of grants: an incomplete hierarchy makes a
node-scoped check undecidable, so it raises rather than denying. Silently
denying there would take out every node-scoped route while every response still
looked healthy.

`app_wide` checks need only `identity.view`; they never consult the hierarchy.

### What a revoked user can still do

For up to the window, a request that should now be denied is allowed. That is the cost of not asking every time, and it is worth stating to whoever owns your access-review process rather than leaving it to be discovered.

The window covers **every** change that can alter an answer, including a moved node — reparenting changes what an inherited grant reaches even though no grant itself changed, which is why the hierarchy is revalidated on the same cadence and not a slower one.

Two ways out, depending on how much you need.

For a **single** high-value operation, ask the API directly through the injected client — the rest of your routes keep the cache:

```ts
const { allowed } = await this.canopy.permissions.evaluate({
  identity_id: identityId,
  permission: "payments.release",
  scope: "node",
  node_id: nodeId,
});
```

For an application that cannot tolerate a stale allow **anywhere**, set the window to zero. Every guarded request then reads fresh, which reinstates a round trip per request — the cost this design exists to remove, so choose it knowingly:

```ts
CanopyModule.forRoot({
  apiKey: process.env.CANOPY_API_KEY,
  authorizationTtlMs: 0,
  resolveIdentity: (request) => request.user?.sub,
});
```

### Bounding a cache miss

A hit costs nothing. A miss reads from Canopy on the request path and holds an inbound request open, so it is bounded: a 5s per-attempt deadline rather than the client-wide 30s, and 1 retry rather than 2, with each wait between attempts capped at one deadline so a `Retry-After` header cannot hold the request past it. Both are settable with `evaluateTimeoutMs` and `evaluateMaxRetries`, and both apply to these reads alone — everything else through the injected client keeps the client-wide values.

**Hanging up when the caller does.** If the client disconnects while a miss is being filled, the guard ends that check rather than finishing a decision no one will read. It watches the response for a close that arrives before anything was written, on Express (where Nest returns the Node response) and on Fastify (where the real response is on `reply.raw`).

The read itself is deliberately **not** cancelled: it may be shared with other requests that are still waiting on it, and it warms the cache either way.

## License

MIT © Canopy Identity Inc.
