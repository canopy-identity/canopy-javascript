---
"@canopy-io/nestjs": minor
---

Bound the permission check so a slow or unreachable Canopy cannot hold a request open.

`CanopyGuard` evaluated with the client-wide defaults — a 30s per-attempt timeout and 2 retries — so a hung call could hold an inbound request for roughly 90s plus backoff, on the authorization path of every guarded route.

The guard now evaluates with a 5s per-attempt deadline (`evaluateTimeoutMs`) and 1 retry (`evaluateMaxRetries`), both configurable and both scoped to the guard — everything else through the injected client keeps the client-wide values. It also caps each wait between attempts at one deadline, because that wait is otherwise set by Canopy's `Retry-After` header and sits outside the deadline entirely: a `Retry-After: 120` on a 429 would have held the inbound request for two minutes regardless of any timeout configured here.

Worst case is now roughly `evaluateTimeoutMs × (2 × evaluateMaxRetries + 1)` — about 15s with the defaults, against unbounded before.

```ts
CanopyModule.forRoot({
  apiKey: process.env.CANOPY_API_KEY,
  evaluateTimeoutMs: 2_000,
  evaluateMaxRetries: 0,
  resolveIdentity: (request) => request.user.sub,
});
```

**A failed check now reports what actually failed.** Every Canopy error became `503 Service Unavailable`, so a rejected or unscoped API key — a permanent misconfiguration — was reported as a temporary outage, inviting retries that could never succeed and hiding the bug. Now: an unreachable, rate-limited or `5xx` Canopy is `503`; a rejected API key or a refused question is `500`; an identity Canopy has never heard of is `403`. Every branch still fails closed.

**A resolver that throws now denies instead of crashing.** `resolveIdentity: (request) => request.user.sub` — the shape the docs suggested — throws on an unauthenticated request, which surfaced as a `500` rather than the documented `403`. Both resolvers are now called defensively: a throw is treated as "could not resolve", the same denial as returning nothing. The documented examples use `request.user?.sub`.

**Registering the guard globally is documented properly.** Nest runs global guards before controller- and route-scoped ones, so a globally-registered `CanopyGuard` runs before route-level authentication has populated the request and every guarded route denies. The README now says to register your authentication guard globally ahead of it, or to apply both at the route.

The guard also aborts the check when the caller disconnects while it is in flight, and propagates that abort rather than reporting `503` — a caller hanging up is not Canopy being unavailable, and it is no longer logged as though it were. Disconnect is detected on the response, on a close arriving before anything was written.

This is resolved per adapter: Express hands back the Node response directly, Fastify hands back a `Reply` whose real response is on `.raw`. A transport with neither, such as GraphQL, runs to the deadline as before. Both adapters are covered by end-to-end tests that boot a real Nest application and hang up a real client mid-check.
