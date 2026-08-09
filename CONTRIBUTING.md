# Contributing

```bash
npm ci
npm run verify   # lint, typecheck, spec drift, test, build — across every package
```

## Build order is load-bearing

`verify` builds first, and builds `@canopy-io/node` before `@canopy-io/nestjs`. That order is deliberate rather than incidental: the NestJS package resolves the client through its published `types` entry, which does not exist until the client has been built, so on a fresh clone every step that reads types fails without it. `npm run build --workspaces` would not do — it runs alphabetically, which is the wrong order here.

## Working on one package

Root scripts fan out across the workspace. To target a single package:

```bash
npm run test --workspace @canopy-io/node
```

## Generating types against an unreleased API

Types come from the published spec by default. To point the generator elsewhere, pass an absolute path — `--workspace` runs with the package directory as the working directory, so a relative one will not resolve the way you expect:

```bash
CANOPY_SPEC_URL="$HOME/Development/canopy/apps/canopy-api/spec/openapi.api.json" \
  npm run generate --workspace @canopy-io/node
```

`npm run generate:check` fails when the committed types no longer match the spec. When the API's surface changes, `EXPECTED_OPERATION_COUNT` in `packages/node/src/coverage.test.ts` moves with it, deliberately, with the reason in the changeset.

## Releasing

Releases use [changesets](https://github.com/changesets/changesets). Include one in any PR that changes a published package:

```bash
npm run changeset
```

`npx changeset version` applies the pending changesets and writes each package's CHANGELOG; `npm run release` builds and publishes whatever is newly versioned.
