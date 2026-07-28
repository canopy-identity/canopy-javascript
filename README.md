# @canopy-io/sdk

Official TypeScript SDK for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

> **Status: pre-release.** The generated types are complete and usable. The ergonomic client (`client.ts`, resources, pagination) is in progress — see [Roadmap](#roadmap).

## Install

```bash
npm install @canopy-io/sdk
```

Requires Node 18 or later. Ships ESM and CommonJS, and has **zero runtime dependencies**.

## Design

Three decisions shape this package.

**Types are generated from the published spec, never hand-written.**
`src/generated/types.ts` comes from <https://canopy-io.com/openapi/api.json>, the same document that renders Canopy's API reference. `npm run generate:check` fails if the committed types no longer match the live spec, so the SDK cannot silently describe an API that has moved on.

**Zero runtime dependencies.**
The client is `fetch` and nothing else, so it runs unchanged on Node, in browsers, on Cloudflare Workers, and on Deno — and it adds no supply-chain surface to anything that installs it. CI fails if a runtime dependency appears.

**The hand-written layer exists for correctness, not convenience.**
Writing a `fetch` call against a documented REST API is easy, and an LLM will do it for you. What neither gets reliably right is the part this package owns:

- **Which operations are safe to retry.** The spec marks them (`x-canopy-idempotent`). Guessing wrong on a POST means a duplicate role assignment.
- **Two pagination styles behind one shape.** The audit log is cursor-paginated; everything else is offset. The top-level response is identical either way, so a hand-rolled loop silently breaks on one of them.
- **The five-shape response envelope.** `{ data }`, `{ items }`, `{ items, pagination }`, `{ summary, results }` for partial success, `{ error }`, and bare 204.
- **Typed error codes.** The spec declares them per operation (`x-canopy-errors`), so `catch (e) { if (e.code === "rbac.assignment_conflict") }` type-checks instead of being a string guess.
- **Webhook signature verification.** Security-critical, and easy to get subtly wrong — timing-unsafe comparison, missing timestamp check.

## Roadmap

- [x] Package scaffold, dual ESM/CJS build, generated types
- [ ] Client core — auth, envelope unwrapping, typed errors, idempotency-aware retry
- [ ] Pagination — one async iterator covering offset and cursor
- [ ] Resource wrappers — `permissions`, `identities`, `roles`, `assignments`
- [ ] Spec-coverage test — every `operationId` reachable from the SDK
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
