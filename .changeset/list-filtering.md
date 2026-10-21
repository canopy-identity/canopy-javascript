---
"@canopy-io/node": minor
"@canopy-io/nestjs": minor
---

`LocalAuthorizer` answers the list question, says why a check was denied, and hears every verdict.

- `grantRoots(identityId, permission)`: the nodes the permission is granted at, in effect now, minus the ones another root already covers, with `envWide` when one is the Environment's root.
- `accessibleNodes(identityId, permission, { maxNodes })`: those roots expanded through their descendants into a `Set` for an `IN (...)` filter, from the same cached tree a check walks. Capped at `maxNodes` (10,000 by default, settable per authorizer or per call); past the cap `nodes` is null and `complete` false, and the roots filter a closure table or materialised path instead.
- `permissionsAt(identityId, nodeId)`: every permission the identity holds at the node, by grant or inheritance; `permissionsAtMany(identityId, nodeIds)` answers several nodes from one read.
- `evaluate` returns `{ allowed, reason }`. On a denial `reason` is `permission_not_held`, `outside_grants`, `expired`, `not_yet_effective` or `node_missing`. The grant roots are read with `include=windows`, so a grant that ends before the TTL is re-read at its boundary.
- `onDecision` and `onDenied` options, fired after every verdict and never awaited; a hook that throws is ignored.
- `canopy.identities.accessibleNodes(id, { permission, max_nodes })` wraps `GET /api/v1/identities/:id/accessible-nodes`, and `canopy.identities.permissions(id, { node_id })` takes the node.

This version reads `GET /api/v1/identities/:id/grants?include=windows`, which Canopy serves from the same release that adds the accessible-nodes endpoint; against an older API the read is refused and every check fails, so upgrade after the API has it.

`@canopy-io/nestjs` accepts `onDecision` and `onDenied` in `CanopyModuleOptions` and passes them to the authorizer; the guard's own behaviour is unchanged.
