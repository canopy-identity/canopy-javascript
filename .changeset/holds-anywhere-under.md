---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

`authorizer.holdsAnywhereUnder(identityId, permission, subtreeRootId)` answers whether the identity holds the permission at a node or anywhere beneath it, as `{ held, roots }`: `roots` is the subtree root alone when a grant at or above it reaches the whole subtree, otherwise the topmost granted nodes inside it. It is the question a menu inside an organization asks, which `app_wide` cannot, since that covers the whole Environment. It is a read for menus and lists, never a guard: a write still checks the node it writes to. It answers from the same cached grants and tree as a check, takes `{ principalType: "service" }` like the other reads, and raises `authorizer.hierarchy_incomplete` for a node the readable hierarchy does not contain. The conformance bundle gains the `holds-anywhere-under` vector, which the authorizer answers.

Your own staff (identities holding a role at the Environment root) carry `org_scope: "all"` on their tokens, now typed on `CanopyTokenClaims`. `orgContext(claims)` gains `staff`, true when a staff session is inside a customer's organization. `canopy.organizations.listStaffActivity(id, query)` pages through every staff entry into an organization and every refusal, filtered by `kind` (`entered` or `refused`), searched by `q`, sorted by `created` or `actor`.

The spec now has 176 operations. Generated types cover the staff activity, the organization policy's `staff_entry`, and an organization's own roles and integrations, which stay unwrapped like its other delegated administration routes.

In `@canopy-io/nestjs`, `scope: "org"` still evaluates only at the token's `org_id`. A staff token that has not entered an organization is denied with a message saying it enters with `switch-organization`; the guard never takes the organization from the route, since entering is what the customer's organization records and may refuse.
