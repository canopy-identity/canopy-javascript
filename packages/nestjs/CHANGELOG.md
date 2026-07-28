# @canopy-io/nestjs

## 0.1.0

### Minor Changes

- 481ee14: Add `@canopy-io/nestjs`, the NestJS integration.

  `CanopyModule.forRoot` registers one configured client and the guard that uses
  it; `@RequirePermission("orders.refund")` on a route turns into a single
  evaluation against Canopy. The `node` scope is the default, so a permission is
  checked at the node the request touches and inherited from ancestors;
  `app_wide` is opt-in because it answers a coarser question and must not guard a
  node-owned resource.

  The guard fails closed. An unresolvable identity, a node check with no node, a
  denial, or an unreachable API all end the request, and an unreachable API is a
  503 rather than a 403 so "we could not decide" is never reported as "you are
  not allowed".
