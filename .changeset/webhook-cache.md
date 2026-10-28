---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

Webhooks reach the `LocalAuthorizer` cache, so a revocation lands on the next local check instead of waiting out `ttlMs`.

- `verifyWebhookSignature({ headers, rawBody, secret })` checks a delivery's `X-Canopy-Signature`: HMAC-SHA256 over `{id}.{timestamp}.{raw body}`, compared in constant time on Web Crypto, so it runs in edge workers as well as Node. It accepts either signature while a rotation's window is open, takes several secrets while you roll one out, and refuses a timestamp more than five minutes from the clock (`toleranceSeconds`). It resolves `false`, never rejects.
- `authorizer.applyEvent(delivery)` drops what a webhook delivery or change-feed entry makes stale and answers what it dropped: the subjects an assignment, membership, identity-status, single-person deny or machine-client change names; everything for a role, permission, node, schema, organization creation or deletion, role deny or directory group mapping; nothing for a change that moves no one's access. An event this version does not know drops everything.
- `authorizer.replayChanges({ cursor })` reads `GET /api/v1/changes` to the newest change, applies each, and answers the cursor to resume from: for catching up after a restart, or polled on every instance in place of webhooks.
- `invalidate` now also discards a read already in flight, so a check that began before a change cannot put the access it revoked back in the cache for a whole window.
