---
"@canopy-io/node": minor
---

`LocalAuthorizer.invalidate(identityId?)` — with an identity id, only that
identity's cached grants are dropped; the hierarchy and every other identity
stay warm. This is the shape an assignment webhook wants: invalidate exactly
the identity the event names. With no argument the behaviour is unchanged
(drop everything). The jsdoc now also states the multi-instance guarantee
honestly: an invalidation reaches one process, so behind a load balancer the
fleet-wide revocation guarantee remains the TTL.
