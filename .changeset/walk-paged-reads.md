---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

Follows Canopy's paged hierarchy, grant, session and directory group reads. These endpoints now answer `{ items, pagination }`, at most 100 to a page, where they used to answer the whole collection.

`LocalAuthorizer`, and so `CanopyGuard`, reads every page of an identity's grant roots (now one row per permission and node) and every page of the hierarchy's parent edges, 100 at a time. Revalidation still costs one request: only the hierarchy's first page is sent with its `ETag`, and a `304` keeps the held copy. When the hierarchy has changed, every page is read again, and a rebuild over several pages is confirmed against the first page's `ETag` so a change made mid-read is not kept half-applied. `snapshot()` gains `grantPages` and `treePages`, the page requests behind `grantFetches` and `treeRequests`. Earlier versions deny every check against a Canopy that answers grants as one row per node, so upgrade before that API reaches you.

Caller shapes that changed:

- `identities.sessions(id, query?)` returns a `Paginator` instead of a promise of `{ items }`, and takes `page` and `take`. Use `for await`, `.all()` or `.first()`.
- `organizations.listDirectoryGroups(id, query?)` returns a `Paginator`, and takes `page`, `take`, `q` (display name or external id) and `sort_by` (`name`, the default, or `created`). The item type is exported as `OrganizationDirectoryGroupItem`.
- `permissions.evaluateBulk` takes between 1 and 100 checks; more is refused with a `400`.
- The generated types follow the API: `GET /api/v1/nodes` and `GET /api/v1/nodes/:id/tree` answer pages of flat nodes (`ScopedNodeResponseDto`, linked by `parent_node_id`) instead of a nested tree with its scope, `GET /api/v1/nodes/:id/children` is paged, and `IdentityGrantResponseDto` carries `node_id` instead of `nodes`. Several lists' `sort_by` is now typed to the columns each accepts.

`@canopy-io/nestjs` picks up the new authorizer; its own options and behaviour are unchanged.
