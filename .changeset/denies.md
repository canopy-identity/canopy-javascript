---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

`LocalAuthorizer` understands authorization model version 2, which Canopy answers in an Environment that holds a deny. A deny refuses a permission to an identity, a machine client or a role's holders at a node and everything beneath it, whatever the grants allow. The grants read carries the subject's deny roots beside its grant roots, already resolved by Canopy (the roles it holds, the exception roles that spare it), and the authorizer applies them from the same cache and TTL:

- `evaluate` refuses with the new reason `denied` when a deny root for the permission is at the node or above it, before any grant is looked at. An `app_wide` check holds while one grant in effect stands clear of every deny, and is `denied` when none does. A check on a permission with a deny reads the tree even for a grant at the node itself.
- `grantRoots` and `accessibleNodes` leave out a root a deny refuses and name `excludedRoots`, the deny roots beneath a root, each cutting out its subtree. `accessibleNodes` leaves those subtrees out of `nodes`, and `envWide` is false while anything is excluded. A filter by roots must exclude `excludedRoots` too.
- `holdsAnywhereUnder` answers `{ held, roots, excludedRoots }`; a deny at the subtree's root or above it refuses the whole subtree.
- `permissionsAt` and `permissionsAtMany` leave out a permission a deny refuses at the node.

`LocalDenialReason` gains `denied`, so an exhaustive `switch` over it needs the new case. A version 1 answer, from a Canopy without denies, carries none and is read as before. The conformance bundle gains the `denies` vector, which the authorizer answers, and is published at model version 2.

The spec now has 197 operations. Generated types cover the Denies routes (`/api/v1/denies`: list, get, create, preview, reach, remove), unwrapped like the other management routes, `deny_id` on an evaluation refused by a deny, and the reads and previews released beside them.
