# Canopy SDKs for JavaScript

Official client libraries for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

## Packages

- **[`@canopy-io/node`](packages/node)** — the server client. Authentication, the response envelope, pagination, typed errors and retry policy, with zero runtime dependencies.
- **[`@canopy-io/nestjs`](packages/nestjs)** — the NestJS integration. Registers the client, and turns a permission check into a decorator on the route.

Everything here is TypeScript, published to npm under the `@canopy-io` scope, and typed from the same [OpenAPI specification](https://canopy-io.com/openapi/api.json) that renders Canopy's API reference — so a package cannot silently describe an API that has moved on.

Other languages are deliberately not planned. Point your own generator at the published spec; that serves Python, Go and the rest better than a partly-maintained SDK would.

## Working in this repo

```bash
npm ci
npm run verify   # lint, typecheck, spec drift, test, build — across every package
```

`verify` builds first, and builds `@canopy-io/node` before `@canopy-io/nestjs`. That order is load-bearing rather than incidental: the NestJS package resolves the client through its published `types` entry, which does not exist until the client has been built, so on a fresh clone every step that reads types fails without it. `npm run build --workspaces` would not do — it runs alphabetically, which is the wrong order here.

Root scripts fan out across the workspace. To work on one package, target it:

```bash
npm run test --workspace @canopy-io/node
```

To generate types against an unreleased API instead of the published spec, pass an absolute path — `--workspace` runs with the package directory as the working directory, so a relative one will not resolve the way you expect:

```bash
CANOPY_SPEC_URL="$HOME/Development/canopy/apps/canopy-api/spec/openapi.api.json" \
  npm run generate --workspace @canopy-io/node
```

## Releasing

Releases use [changesets](https://github.com/changesets/changesets). Include one in any PR that changes a published package:

```bash
npm run changeset
```

`npx changeset version` applies the pending changesets and writes each package's CHANGELOG; `npm run release` builds and publishes whatever is newly versioned.

## License

MIT © Canopy Identity Inc.
