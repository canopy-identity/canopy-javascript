# @canopy-io/node

Official TypeScript SDK for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

This package is the client. It calls Canopy's API, and it verifies the access tokens Canopy issues.

## Install

```bash
npm install @canopy-io/node
```

Requires Node 18 or later. Ships ESM and CommonJS, and has **zero runtime dependencies**.

Despite the name, it is not Node-only: the client is `fetch` and nothing else, so the same build runs in browsers, on Cloudflare Workers and on Deno.

## Features

- **Typed resource wrappers** for `permissions`, `identities`, `roles` and `assignments` — the four every integration touches.
- **The whole API, typed.** Any operation without a wrapper is reachable through `canopy.client.request` with the same envelope handling, error typing and retry policy.
- **Both credential types.** An API key (`cnpy_…`, sent as `X-API-Key`) for server-to-server calls, or an identity or portal JWT sent as a bearer token.
- **Envelope unwrapping.** All five response shapes are handled, so a call returns the payload rather than a wrapper.
- **Pagination as an async iterator.** One `for await` loop covers both the offset and cursor styles, and `paginate` exposes the same machinery for anything hand-rolled.
- **A retry policy that knows what is safe to replay** — idempotent methods and 429s only, with `Retry-After` honoured and capped.
- **Concurrency and idempotency headers.** `withConcurrency` carries a resource's `version` as `If-Match`; `Idempotency-Key` is accepted on the bulk endpoints that support it.
- **Typed errors.** `CanopyError` carries a stable `code`, `CanopyConnectionError` marks a transport failure, `CanopyTokenError` a rejected token, `CanopyAuthorizerError` a check that could not be decided — each with a type guard.
- **Local access-token verification.** `TokenVerifier` checks Canopy's RS256 signatures against the published key set: one JWKS fetch, then no network on any verification after it.
- **Local authorization.** `LocalAuthorizer` answers permission checks in-process from an identity's grant roots and a shared copy of your hierarchy, so a check costs a walk up the tree rather than a round trip.
- **Conditional reads.** `requestConditional` sends the validator you already hold and tells you whether anything changed, so something expensive can be held and revalidated cheaply.
- **Deadlines and cancellation.** A per-attempt timeout and a caller's own `AbortSignal`, settable client-wide or per call.
- **Types generated from the published spec**, with CI failing on drift.

## Usage

```ts
import { Canopy, isCanopyError } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });

// The call every integrator makes on every request.
const { allowed } = await canopy.permissions.evaluate({
  identity_id: identityId,
  permission: "documents.read",
  scope: "node",
  node_id: nodeId,
});

// Pagination is handled for you, whichever style the endpoint uses.
for await (const identity of canopy.identities.list({ take: 50 })) {
  console.log(identity.email);
}

// Errors carry a stable code, not just a message.
try {
  await canopy.assignments.create({
    identity_id: identityId,
    node_id: nodeId,
    role_id: roleId,
  });
} catch (error) {
  if (isCanopyError(error) && error.code === "rbac.assignment_conflict") {
    // Already assigned — not a failure worth surfacing.
  } else {
    throw error;
  }
}
```

Anything without a typed wrapper is reachable the same way, with the same envelope handling and retry policy:

```ts
const page = await canopy.client.request("GET", "/api/v1/audit-events", {
  query: { limit: 50 },
});
```

### Verifying an access token

Authorization asks the API a question. Authentication does not: Canopy signs
access tokens RS256 and publishes the keys, so a token is checked locally —
one JWKS fetch, then no network on any verification after it.

```ts
import { TokenVerifier, isCanopyTokenError } from "@canopy-io/node";

const verifier = new TokenVerifier();

try {
  const claims = await verifier.verify(bearerToken);

  claims.sub; // the identity or user id
  claims.type; // "identity" | "user" | "api_key" | "platform"
  claims.environment_id; // present on identity tokens
} catch (error) {
  if (isCanopyTokenError(error)) {
    // Every code here means 401 to the caller who presented the token.
    // `error.code` is for your logs: token.expired, token.signature_invalid,
    // token.issuer_mismatch, and so on.
  }

  throw error;
}
```

Hosted Login tokens carry an audience, so name your client. Direct API tokens
carry none and need no option — and a token that has an `aud` is refused
rather than ignored when you have not said which client you are:

```ts
new TokenVerifier({ audience: process.env.CANOPY_OAUTH_CLIENT_ID });
```

Self-hosted instances set `issuer`. Getting it wrong fails closed: tokens are
rejected, never mistakenly accepted.

### Authorizing without a call per request

Asking "may this identity act _here_" on every request puts Canopy in your
request path forever. `LocalAuthorizer` asks the other question — "**where** may
it act" — once, and answers everything after that in-process.

```ts
import { Canopy, LocalAuthorizer } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
const authorizer = new LocalAuthorizer(canopy.client);

const { allowed } = await authorizer.evaluate({
  identity_id: identityId,
  permission: "reports.view",
  node_id: nodeId,
});
```

It holds two things: the identity's grant roots, and one copy of your hierarchy
— read as parent edges from `GET /api/v1/nodes/parents` rather than the full
tree, which is 3.7x smaller — shared across every identity in the process. A check walks up from the node in
question looking for a grant root — a grant already means _this node and
everything beneath it_, so the roots are never expanded into their descendants.

Both are held for at most 60 seconds, which is the delay between an access
change and it taking effect, including a moved node. Set `ttlMs` to change it,
knowing that shortening it below the gap between a user's requests saves
nothing — every request then finds the cache expired and refetches.

`canopy.permissions.evaluate` remains for a decision with no staleness at all.

The credential needs to be able to read both halves. A `full_access` API key
already can; a **scoped** one must list `identity.view` (the grant roots) and
`hierarchy.view` (the tree). Without the latter the tree endpoint answers an
empty tree and a `200` — it is telling you what you may see, which is nothing —
so a node-scoped check raises `CanopyAuthorizerError` rather than returning
`false`. Not being able to see the hierarchy is not the same as the identity
lacking the permission, and answering `false` there would deny every
node-scoped request while looking entirely healthy.

## What the hand-written layer is for

Writing a `fetch` call against a documented REST API is easy, and an LLM will do it for you. What neither gets reliably right is the part this package owns:

- **Which operations are safe to retry.** GET, HEAD, PUT and DELETE are idempotent by HTTP definition and are retried on a 5xx; POST is not, and a blind retry there can create a second role assignment. A 429 is retried regardless, because the request was refused before anything happened. A caller's own cancellation is never retried — aborting a `signal` rejects with that abort, while timeouts and transport failures throw `CanopyConnectionError`.
- **The protocol headers that make a write safe.** `If-Match` carries a resource's current `version`, so a concurrent edit answers 409 instead of being silently overwritten; `Idempotency-Key` makes a replayed bulk create return the original result rather than creating rows twice.
- **Two pagination styles behind one shape.** The audit log is cursor-paginated; everything else is offset. The top-level response is identical either way, so a hand-rolled loop silently reads only the first page of one of them — or never terminates.
- **The five-shape response envelope.** `{ data }`, `{ items }`, `{ items, pagination }`, `{ summary, results }` for partial success, `{ error }`, and bare 204.
- **Typed error codes.** `catch (e) { if (e.code === "rbac.assignment_conflict") }` branches on a contract rather than on a message that may be reworded.
- **The traps in verifying a token.** Pinning the algorithm so `alg: none` and HMAC key-confusion cannot get in, bounding `kid`-triggered refetches so a forged header cannot hammer the issuer, refusing to ignore an `aud` the token carries, and refusing a **pre-auth** token — genuine, correctly signed, and issued before the user picked an Account, so treating it as a session is a privilege escalation.
- **The traps in caching an authorization answer.** Holding grant roots rather than expanded node lists, so the cache does not grow with your tree and is not largest for the administrators who have the most access. Revalidating the hierarchy on the same cadence as the grants, because a moved node changes what an inherited grant reaches while the grant itself stays untouched. Sharing one in-flight read across concurrent requests, so a cold start under load does not fan out into the per-request traffic the cache exists to remove. And never serving a held answer past its window to ride out an outage, which would extend the revocation window without anyone choosing to.

## Design

**Types are generated from the published spec, never hand-written.**
`src/generated/types.ts` comes from <https://canopy-io.com/openapi/api.json>, the same document that renders Canopy's API reference. `npm run generate:check` fails if the committed types no longer match the live spec, so the SDK cannot silently describe an API that has moved on.

**Zero runtime dependencies.**
The client is `fetch` and nothing else, so it runs unchanged on Node, in browsers, on Cloudflare Workers, and on Deno — and it adds no supply-chain surface to anything that installs it. CI fails if a runtime dependency appears.

## License

MIT © Canopy Identity Inc.
