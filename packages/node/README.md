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

- **Typed resource wrappers** for `permissions`, `identities`, `roles`, `assignments` and `organizations` — the ones every integration touches.
- **The whole API, typed.** Any operation without a wrapper is reachable through `canopy.client.request` with the same envelope handling, error typing and retry policy.
- **Both credential types.** An API key (`cnpy_…`, sent as `X-API-Key`) for server-to-server calls, or an identity or portal JWT sent as a bearer token.
- **Envelope unwrapping.** All five response shapes are handled, so a call returns the payload rather than a wrapper.
- **Pagination as an async iterator.** One `for await` loop covers both the offset and cursor styles, and `paginate` exposes the same machinery for anything hand-rolled.
- **A retry policy that knows what is safe to replay** — idempotent methods and 429s only, with `Retry-After` honoured and capped.
- **Concurrency and idempotency headers.** `withConcurrency` carries a resource's `version` as `If-Match`; `Idempotency-Key` is accepted on the bulk endpoints that support it.
- **Typed errors.** `CanopyError` carries a stable `code`, `CanopyConnectionError` marks a transport failure, `CanopyTokenError` a rejected token, `CanopyAuthorizerError` a check that could not be decided — each with a type guard.
- **Local access-token verification.** `TokenVerifier` checks Canopy's RS256 signatures against the published key set: one JWKS fetch, then no network on any verification after it.
- **Local authorization.** `LocalAuthorizer` answers permission checks in-process from an identity's grant roots and a shared copy of your hierarchy, so a check costs a walk up the tree rather than a round trip.
- **Webhooks wired to the cache.** `verifyWebhookSignature` checks a delivery in constant time, `authorizer.applyEvent` drops exactly what the change made stale, and `authorizer.replayChanges` catches up from the change feed.
- **Conditional reads.** `requestConditional` sends the validator you already hold and tells you whether anything changed, so something expensive can be held and revalidated cheaply.
- **Deadlines and cancellation.** A per-attempt timeout and a caller's own `AbortSignal`, settable client-wide or per call.
- **Types generated from the published spec**, with CI failing on drift.

## Usage

```ts
import { Canopy, isCanopyError } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });

// A fresh decision from the API. On the request path, prefer LocalAuthorizer
// (below), which answers in-process.
const { allowed } = await canopy.permissions.evaluate({
  identity_id: identityId,
  permission: "documents.read",
  scope: "node",
  node_id: nodeId,
});

// Pagination is handled for you, whichever style the endpoint uses. Every
// list method returns a Paginator: `for await`, `.all()` or `.first()`.
for await (const identity of canopy.identities.list({ take: 50 })) {
  console.log(identity.email);
}

const newest = await canopy.identities.sessions(identityId).first();

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

Lists answer 20 items a page by default and at most 100 (`take`).
`permissions.evaluateBulk` takes 1 to 100 checks in one request; more is
refused with a `400` and nothing is evaluated, so send a larger set in batches.

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
import { TokenVerifier, tokenErrorStatus } from "@canopy-io/node";

const verifier = new TokenVerifier({
  environmentId: process.env.CANOPY_ENVIRONMENT_ID,
});

try {
  const claims = await verifier.verify(bearerToken);

  claims.sub; // the identity's id
  claims.type; // "identity", the only type accepted by default
  claims.environment_id; // present on identity tokens
} catch (error) {
  // 401 when the token is at fault, 503 when the signing keys could not be
  // read and the token may be good. `error.code` is for your logs:
  // token.expired, token.signature_invalid, token.jwks_unavailable, ...
  const { status, message } = tokenErrorStatus(error);

  return response.status(status).json({ message });
}
```

A verifier accepts only identity tokens, the people who sign in to your
application. Canopy signs tokens for its own administrators (`user`), its
staff (`platform`) and some API key flows (`api_key`) with the same keys and
issuer, so they are refused with `token.type_not_allowed` unless you name them:
`new TokenVerifier({ ..., allowedTypes: ["identity", "user"] })`.

A **machine client** (an OAuth client registered with `client_kind: machine`)
obtains tokens for itself with the `client_credentials` grant. Its token's
`type` is `service`, its `sub` and `client_id` are the client's `client_id`,
and `gty` is `client_credentials`. Its `aud` names the API it was minted for
(the `audience` the client asked for, or the Environment's default audience),
so name yours as `serviceAudience`; `audience` stays the OAuth client a
person's token is for. Admit service tokens on the one call that serves
machines rather than on the whole verifier, so routes built for people keep
refusing them:

```ts
const verifier = new TokenVerifier({
  environmentId: process.env.CANOPY_ENVIRONMENT_ID,
  serviceAudience: "https://api.example.com",
});

const claims = await verifier.verify(bearerToken, { alsoAllow: ["service"] });

if (claims.type === "service") {
  claims.sub; // the machine client's client_id
}
```

A machine client pinned to an organization carries that organization's claims,
read through `orgContext` like a person's.

If Canopy cannot be reached when the cached keys are due for a refresh, the
verifier keeps verifying with the keys it holds; only a verifier that has never
loaded a key set, or a token signed by a key it has never seen, answers
`token.jwks_unavailable`.

Hosted Login tokens carry an audience, your `client_id`, so name your client.
Direct API tokens carry none and need no option. A token that has an `aud` is
refused rather than ignored when you have not said which client you are, so a
token minted for another client is never accepted by accident:

```ts
new TokenVerifier({ audience: process.env.CANOPY_OAUTH_CLIENT_ID });
```

Every Environment is its own issuer, so name yours:

```ts
new TokenVerifier({ environmentId: process.env.CANOPY_ENVIRONMENT_ID });
```

On a custom auth domain or a self-hosted instance, set `issuer` instead
(`https://auth.acme.com`, or `<origin>/environments/<id>`). The constructor
throws with neither. Getting it wrong fails closed: tokens are rejected, never
mistakenly accepted.

With an Environment's **organizations** container on, an identity token also
names the organization the session is acting in and the roles held at that
organization's node, by name and by id. Read them through `orgContext` rather
than off the raw claims: Canopy mints `org_id`, `org_roles` and `org_role_ids`
together, and the helper refuses a partial set or names and ids that do not
pair up:

```ts
import { orgContext } from "@canopy-io/node";

const org = orgContext(claims);

if (org) {
  org.orgId; // the organization — also a hierarchy node id
  org.orgRoles; // the roles held at its node, by name; [] for a member holding none there
  org.orgRoleIds; // the same roles' ids, in the same order
  org.staff; // true for your staff inside a customer's organization
}
```

Your own staff are identities holding a role at the Environment root. Their
tokens carry `org_scope: "all"`, and once one enters a customer's
organization `orgContext` answers with `staff: true` and the root roles as
`orgRoles`. The organization sees every entry in its staff activity
(`canopy.organizations.listStaffActivity(id)`) and can refuse staff
altogether, so say in your interface when a session is staff.

`null` is an ordinary answer: every token from an Environment without the
container on, and every identity that belongs to no organization yet. An empty
`orgRoles` is not: membership is admission, and a member may hold roles only
beneath the organization. Authorize by evaluating, never by the list.

A grant inside an organization counts only while the membership is active.
The grants `LocalAuthorizer` caches already apply that: a deactivated
membership drops every grant inside the organization from the next read, so
the authorizer sees it within the cache TTL, and at once when the
`organization.member.removed` webhook is passed to `authorizer.applyEvent`.

Tokens also carry `amr`, how the session was proven (`pwd`, `otp` or `sso`,
plus `mfa` once a second factor was verified), so a backend can insist on
`claims.amr?.includes("mfa")` before a sensitive action.

The organizations themselves are wrapped on the client: provision a tenant,
manage its members and invitations, tighten its sign-in policy, bind its
identity provider, and set up its directory sync.

```ts
const acme = await canopy.organizations.create({ name: "Acme Corp" });

await canopy.organizations.addMember(acme.id, {
  identity_id: identityId,
  role_id: ownerRoleId,
});

// Invite by email straight to an office, for a fixed window. Someone already
// in the Environment receives a request to join, and accepting is their consent.
await canopy.organizations.createInvite(acme.id, {
  email: "lee@acme.example",
  role_id: agentRoleId,
  node_id: euOfficeId,
  effective_to: "2026-12-31T23:59:59.999Z",
});

// An organization only tightens the Environment: a second factor where the
// Environment leaves it optional, and only some of the Environment's ways in.
await canopy.organizations.updatePolicy(acme.id, {
  mfa_required: true,
  allowed_sign_in_methods: ["password", "sso"],
});
```

Directory sync (SCIM) opens when you name the roles an organization's identity
provider may grant; the organization's own admin can read that list but not
change it. The token is returned once, with the full base URL its connector
needs.

```ts
await canopy.organizations.setDirectoryGrantableRoles(acme.id, {
  role_ids: [memberRoleId, leadRoleId],
  default_role_id: memberRoleId,
});

await canopy.organizations.createDirectory(acme.id);

const { token, base_url } = await canopy.organizations.mintDirectoryToken(
  acme.id,
  { name: "Okta" },
);
```

### Handling webhooks

Check every delivery's signature before acting on it, over the body exactly
as it arrived, then hand it to the authorizer and to your own handlers.
Every webhook event has a published schema, and the SDK types deliveries from
it: narrow by event name and read that event's `metadata` without a cast.

```ts
import express from "express";
import {
  isWebhookEvent,
  verifyWebhookSignature,
  type WebhookDelivery,
} from "@canopy-io/node";

app.post(
  "/webhooks/canopy",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const valid = await verifyWebhookSignature({
      headers: req.headers,
      rawBody: req.body,
      secret: process.env.CANOPY_WEBHOOK_SECRET,
    });

    if (!valid) {
      return res.sendStatus(401);
    }

    const delivery = JSON.parse(req.body.toString()) as WebhookDelivery;

    authorizer.applyEvent(delivery);

    if (isWebhookEvent(delivery, "organization.member.added")) {
      const { identity_id, role_id } = delivery.data.metadata;
      // ...
    }

    res.sendStatus(204);
  },
);
```

`verifyWebhookSignature` resolves `false` for a missing header, a signature
that matches no secret, or an `X-Canopy-Timestamp` more than five minutes
from this machine's clock (`toleranceSeconds` changes it). For a while after
you rotate the secret the header carries two signatures, the new secret's
first, so a receiver still holding the old secret keeps verifying. To roll
the new secret out without a gap, pass both: `secret: [newSecret, oldSecret]`.
It runs on Web Crypto, so it works in edge workers as well as Node.

Deliveries are at least once. `X-Canopy-Webhook-Id` is the same across
retries: use it as an idempotency key for your own handlers. `applyEvent` is
safe to repeat.

`WebhookEvent<"assignment.updated">` is the delivery of one event, and
`WebhookEventName` is every event a subscription can receive. The API's
`GET /api/v1/webhooks/event-types` names each event's schema in
`payload_schema`. A field the API adds arrives with the next
`npm run generate`.

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
node list, which is 3.7x smaller — shared across every identity in the process. A check walks up from the node in
question looking for a grant root — a grant already means _this node and
everything beneath it_, so the roots are never expanded into their descendants.

Both reads are paged, and the authorizer reads every page, 100 rows at a time:
`GET /api/v1/identities/:id/grants` answers one row per permission and node
it was granted at, and the hierarchy arrives 100 parent edges to a page. Only
the hierarchy's first page is revalidated: its `ETag` covers the whole
hierarchy, so a `304` keeps the copy held without reading any other page. When
the hierarchy has changed, every page is read again and the copy rebuilt; a
rebuild over several pages is then confirmed against the first page's `ETag`,
and read again if the hierarchy changed while its pages were being read. At
50,000 nodes a rebuild is 501 requests, and a revalidation is one.

Both are held for at most 60 seconds, which is the delay between an access
change and it taking effect, including a moved node, unless a webhook or the
change feed drops them sooner (see "Revoking before the window lapses"). Set `ttlMs` to change it,
up to five minutes (`300_000`); a longer value throws when the authorizer is
created. Shortening it below the gap between a user's requests saves nothing:
every request then finds the cache expired and refetches.

Each answer carries a reason when it is no, from what the grant roots and the
tree can say: `permission_not_held`, `outside_grants`, `expired`,
`not_yet_effective`, `denied`, or `node_missing` for a `node` check with no
node. The
grant roots are read with their windows, so a grant that ends sooner than the
TTL is dropped at its boundary, not at the next expiry. `onDecision` and
`onDenied` hooks hear every verdict after it is reached, never awaited and
never able to change it, for audit trails and alerting without a fork of the
guard.

A deny refuses a permission at a node and everything beneath it, whatever the
grants allow. The grants read carries the identity's deny roots beside its
grant roots, already resolved by Canopy (the roles it holds, the exception
roles that spare it), so a check refuses with `denied` when a deny root for
the permission is at the node or above it, before any grant is looked at. An
`app_wide` check holds while one grant in effect stands clear of every deny.
Denies ride the same cache and TTL as grants: a deny created or deleted
reaches this authorizer within `ttlMs`, and at once through `applyEvent`,
which drops the one person a deny names and everything for a deny on a role,
since a deny on a role binds everyone holding it.

A machine client's grants are its own, read from
`GET /api/v1/oauth-clients/:id/grants`. Pass `principal_type: "service"` with
the client's `client_id` as `identity_id`; the list reads and `invalidate` take
`{ principalType: "service" }`. The two kinds are cached apart, so a client
never answers from a person's grants. An assignment webhook naming a machine
client carries its `client_id` in `data.metadata.client_id`, the id it is
cached under; `applyEvent` reads it from there. By hand:

```ts
await authorizer.evaluate({
  identity_id: claims.sub,
  principal_type: claims.type === "service" ? "service" : "identity",
  permission: "orders.import",
  node_id: nodeId,
});

authorizer.invalidate(clientId, { principalType: "service" });
```

```ts
const authorizer = new LocalAuthorizer(canopy.client, {
  onDenied: ({ query, decision }) =>
    audit.record("denied", { ...query, reason: decision.reason }),
});
```

A list needs the other direction: which nodes may this identity see. The same
cache answers it, in the shape your query wants. `grantRoots` names the nodes
the permission is granted at, in effect now, minus the ones another root
already covers or a deny refuses, and says whether one is the Environment's
root (`envWide`: every node qualifies, so no filter). `excludedRoots` names
the deny roots beneath those roots; each cuts out its subtree, and `envWide`
is false while there are any. `accessibleNodes` expands the roots through
their descendants, leaving the excluded subtrees out, into a `Set` for an
`IN (...)` filter, capped at `maxNodes` (10,000 by default, per authorizer or
per call); past the cap it hands back the roots with `nodes: null` and
`complete: false`, so an application with a closure table or a materialised
path filters by "beneath a root and not beneath an excluded root" instead. `permissionsAt` lists what the identity holds at one node, for
rendering a screen's controls, and `permissionsAtMany` answers several nodes
from one read, for the rows of a list.

```ts
const access = await authorizer.accessibleNodes(identityId, "reports.view");

if (access.envWide) {
  return db.reports.findMany();
}

if (!access.complete) {
  // Too large for an IN (...) list: filter beneath access.roots, and not
  // beneath access.excludedRoots, instead.
}

return db.reports.findMany({ where: { nodeId: { in: [...access.nodes] } } });
```

A menu inside an organization asks something narrower: does this person
hold the permission anywhere in it? `app_wide` cannot say, since it covers the
whole Environment, so a grant in another organization would show the menu
here too. `holdsAnywhereUnder` answers for one subtree, with `roots` as the
subtree root alone when a grant at or above it reaches all of it, and
otherwise the topmost granted nodes inside it, with `excludedRoots` as the
deny roots inside those. A deny at the subtree's root or above it refuses the
whole subtree:

```ts
const { held, roots } = await authorizer.holdsAnywhereUnder(
  identityId,
  "invoice.approve",
  org.orgId,
);

// held: show the Invoices menu. roots: the teams whose invoices to list.
```

It is a read for menus and lists, never a guard: holding the permission
somewhere in Acme approves no particular invoice, so the write checks the
invoice's own node.

A list filtered this way is what to show; the write that follows still checks
its node. Canopy answers the same question fresh, for a process without the
authorizer, as `canopy.identities.accessibleNodes(id, { permission })`.

`canopy.permissions.evaluate` remains for a decision with no staleness at all.

#### Revoking before the window lapses

`authorizer.applyEvent(delivery)` takes a webhook delivery and drops what
it makes stale, and answers what it dropped:

- A change naming whose access moved (an assignment, an Environment or
  organization membership, an identity's status, a deny on one person, a
  machine client disabled or deleted) drops those subjects' grants and keeps
  everyone else's, and the hierarchy, warm.
- A change whose reach it cannot name (a role, a permission, a node, the
  hierarchy schema, an organization created or deleted, a deny on a role, a
  directory group mapped) drops everything.
- A change that moves no one's access (a profile edit, a sign-in policy, a
  session revoked) drops nothing. An event this version does not know drops
  everything, since guessing it harmless is the unsafe direction.

A check already reading from Canopy when the change lands answers from what
it read, but what it read is not kept, so the next check sees the change.

`authorizer.replayChanges({ cursor })` reads `GET /api/v1/changes` from
`cursor` to the newest change, applies each one the same way, and answers the
cursor to keep for next time. Run it at startup to catch up on what a process
missed while it was down, or on an interval in place of webhooks:

```ts
let cursor: string | null = await loadCursor();

setInterval(async () => {
  ({ cursor } = await authorizer.replayChanges({ cursor }));
  await saveCursor(cursor);
}, 15_000);
```

With no cursor it starts at the oldest change Canopy still retains, so the
first replay walks that window once.

A webhook reaches one process. With several instances behind a load
balancer, `applyEvent` drops the cache of the one that received it, and the
others keep theirs until their own TTL runs out. Either fan the delivery out
to every instance over your own pub/sub, or have every instance run
`replayChanges` on an interval shorter than `ttlMs`. Otherwise the TTL stays
the fleet-wide revocation guarantee.

`authorizer.invalidate(identityId)` remains for a change your own backend
makes and knows about: it drops one identity's cached grants, and with no
argument everything.

A failed check (Canopy unreachable, a credential that cannot read the
hierarchy, an identity not in the Environment, or a Canopy serving an
authorization model this version does not know) throws rather than answering
`false`. The grant roots and the hierarchy each carry the `model_version` of
the rules they describe; an unknown one is refused with `CanopyAuthorizerError`
(`authorizer.model_version_unknown`) instead of being walked as if the rules
had not changed, and upgrading the package is the fix. `authorizationErrorStatus` turns the error into the response to send:
`503` when Canopy did not answer, `500` for a misconfiguration no retry fixes,
`403` for an identity Canopy does not know. The NestJS guard uses the same
mapping.

```ts
import { authorizationErrorStatus } from "@canopy-io/node";

try {
  const { allowed } = await authorizer.evaluate(query);

  if (!allowed) {
    return response.status(403).json({ message: "Forbidden" });
  }
} catch (error) {
  const { status, message } = authorizationErrorStatus(error);

  return response.status(status).json({ message });
}
```

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

## Changelog

[CHANGELOG.md](./CHANGELOG.md) records every published version. The package is
pre-1.0: while the surface is still settling, a minor bump may carry a breaking
change, so read the entry before taking one.

## License

MIT © Canopy Identity Inc.
