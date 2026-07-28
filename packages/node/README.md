# @canopy-io/node

Official TypeScript SDK for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

> **Status: 0.1.0.** The client, pagination and the four main resources are built and tested. 27 of 81 operations have a typed wrapper; the rest are reachable through `canopy.client.request` with the same envelope handling, error typing and retry policy.

## Install

```bash
npm install @canopy-io/node
```

Requires Node 18 or later. Ships ESM and CommonJS, and has **zero runtime dependencies**.

Despite the name, it is not Node-only: the client is `fetch` and nothing else, so the same build runs in browsers, on Cloudflare Workers and on Deno.

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

Anything without a typed wrapper is still reachable, with the same envelope
handling and retry policy:

```ts
const page = await canopy.client.request("GET", "/api/v1/audit-events", {
  query: { limit: 50 },
});
```

## Design

Three decisions shape this package.

**Types are generated from the published spec, never hand-written.**
`src/generated/types.ts` comes from <https://canopy-io.com/openapi/api.json>, the same document that renders Canopy's API reference. `npm run generate:check` fails if the committed types no longer match the live spec, so the SDK cannot silently describe an API that has moved on.

**Zero runtime dependencies.**
The client is `fetch` and nothing else, so it runs unchanged on Node, in browsers, on Cloudflare Workers, and on Deno — and it adds no supply-chain surface to anything that installs it. CI fails if a runtime dependency appears.

**The hand-written layer exists for correctness, not convenience.**
Writing a `fetch` call against a documented REST API is easy, and an LLM will do it for you. What neither gets reliably right is the part this package owns:

- **Which operations are safe to retry.** GET, HEAD, PUT and DELETE are idempotent by HTTP definition and are retried on a 5xx; POST is not, and a blind retry there can create a second role assignment. A 429 is retried regardless, because the request was refused before anything happened. A caller's own cancellation is never retried — aborting a `signal` rejects with that abort, while timeouts and transport failures throw `CanopyConnectionError`.
- **The protocol headers that make a write safe.** `If-Match` carries a resource's current `version`, so a concurrent edit answers 409 instead of being silently overwritten; `Idempotency-Key` makes a replayed bulk create return the original result rather than creating rows twice.
- **Two pagination styles behind one shape.** The audit log is cursor-paginated; everything else is offset. The top-level response is identical either way, so a hand-rolled loop silently reads only the first page of one of them — or never terminates.
- **The five-shape response envelope.** `{ data }`, `{ items }`, `{ items, pagination }`, `{ summary, results }` for partial success, `{ error }`, and bare 204.
- **Typed error codes.** `catch (e) { if (e.code === "rbac.assignment_conflict") }` branches on a contract rather than on a message that may be reworded.
- **Webhook signature verification.** Security-critical, and easy to get subtly wrong — timing-unsafe comparison, missing timestamp check. _(Not built yet — see the roadmap.)_

## Roadmap

- [x] Package scaffold, dual ESM/CJS build, generated types
- [x] Client core — auth, envelope unwrapping, typed errors, retry
- [x] Pagination — one async iterator covering offset and cursor
- [x] Resource wrappers — `permissions`, `identities`, `roles`, `assignments`
- [x] Spec-drift guard — fails when the API's surface changes
- [ ] Webhook signature verification

Other languages are deliberately **not** planned here. Point your own generator at the published spec — that serves Python, Go and the rest better than a partly-maintained SDK would.

## Contributing

```bash
npm ci
npm run verify   # lint, typecheck, spec drift, test, build
```

To work against an unreleased API, point the generator somewhere else:

```bash
CANOPY_SPEC_URL=../canopy/apps/canopy-api/spec/openapi.api.json npm run generate
```

Releases use [changesets](https://github.com/changesets/changesets). Include one in your PR:

```bash
npm run changeset
```

## License

MIT © Canopy Identity Inc.
