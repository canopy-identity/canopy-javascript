# @canopy-io/nextjs

## 0.1.0

### Minor Changes

- 558786a: Add `@canopy-io/nextjs`: sign a Next.js app in on the server through Canopy's hosted login as a confidential client, keep the session in an encrypted HttpOnly cookie, refresh it in the proxy, and check permissions in server components, route handlers and server actions with `auth()`. Checks the access token can answer cost no request; checks at a node read the identity's grants through `@canopy-io/node`'s local authorizer.
