---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

Answer permission checks in-process instead of calling Canopy on every request.

**Behavior change — `CanopyGuard` no longer makes a network call per guarded request.** It asks a different question, once: rather than "may this identity act _here_", it reads _where_ the identity may act and answers everything after that locally.

Two things are held, split by what they depend on: the identity's grant roots, and one copy of your hierarchy shared by every identity in the process. A check walks up from the node in question looking for a grant root. Grant roots are never expanded through their descendants — a grant already means "this node and everything beneath it", and expanding would restate the hierarchy once per identity, largest for the near-root grants administrators hold.

```ts
CanopyModule.forRoot({
  apiKey: process.env.CANOPY_API_KEY,
  authorizationTtlMs: 60_000, // the default
  resolveIdentity: (request) => request.user?.sub,
});
```

**Both are held for at most 60 seconds, which is the delay between an access change and it taking effect.** A revoked user can still act for up to a minute. The window covers everything that can alter an answer, including a moved node — reparenting changes what an inherited grant reaches even though no grant changed, so the hierarchy is revalidated on the same cadence and not a slower one.

Set `authorizationTtlMs: 0` to switch caching off and read fresh on every check. That reinstates a round trip per request, so reach for it knowingly. For a single high-value operation, ask the API directly through the injected client instead — `canopy.permissions.evaluate` is unchanged.

Do not shorten the window below the gap between a user's requests: every request then finds the cache expired and refetches, which is the per-request traffic this removes.

**`LocalAuthorizer`** (`@canopy-io/node`) is the same machinery without NestJS. **`requestConditional`** sends a validator you already hold and reports whether anything changed, so something expensive can be revalidated cheaply.

**Requires a credential that can read both halves.** A `full_access` API key already can; a scoped one needs `identity.view` and `hierarchy.view`. Without the latter the hierarchy endpoint answers an empty tree and a `200` — so a node-scoped check raises `CanopyAuthorizerError` rather than returning `false`. Not being able to see the hierarchy is not the same as the identity lacking the permission, and answering `false` there would deny every node-scoped request while looking entirely healthy.

`CanopyGuard` still fails closed at every step. A `404` with no error code — the API not serving the grants endpoint at all — is reported as a misconfiguration rather than a denial, because denying there would take out every guarded route at once while reading as ordinary policy.
