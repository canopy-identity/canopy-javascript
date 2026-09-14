# Contributing

```bash
npm ci
npm run verify   # build, lint, typecheck, spec drift, test — across every package
```

Run `verify` before every push, not the pieces: CI runs the same steps in the
same order, and skipping one locally (lint is the usual casualty) is how a PR
goes red on the first run. CI adds two guards `verify` does not: it packs each
package and resolves it every way a consumer can (`npm run check:packaging`),
and it fails if `@canopy-io/node` ever gains a runtime dependency.

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

## After a Canopy deploy

A Canopy deploy that changes the public API surface makes the committed types
stale, and nothing in either repository says so on its own: `generate:check`
runs on every PR here, so the drift is found only when someone next opens one
for another reason. Two things cover that gap.

- The **Spec drift** workflow (`.github/workflows/spec-drift.yml`) runs every
  Monday against `development` and opens an issue labelled `spec-drift` when
  the types have moved. Run it by hand from the Actions tab right after a
  deploy that touched the public surface rather than waiting for the schedule.
  A run that could not reach the spec shows a warning, not a failure.
- **Regenerating is a normal PR.** On a branch off `development`:

  ```bash
  npm run generate
  git diff packages/node/src/generated/types.ts   # this diff is what changed in the API
  ```

  If an operation was added or removed, move `EXPECTED_OPERATION_COUNT` and say
  why in the changeset. Add the changeset, run `verify`, open the PR into
  `development`, then release it as below. Identity-auth, portal and SCIM
  endpoints are not in the public spec this package is generated from, so a
  Canopy change confined to those surfaces produces no drift here.

## Releasing

Nothing is versioned or published from a laptop. The whole release runs in CI,
and the only manual steps are two pull requests.

1. **Every PR that changes a published package carries a changeset.** Run
   `npm run changeset` and write the entry for a consumer deciding whether to
   take the bump: what they gain, and whether any caller shape changed. It
   becomes that version's `CHANGELOG.md` entry and the body of its GitHub
   Release, verbatim. Patch when additive, minor when a shape changed; the
   packages are pre-1.0, so a minor is the signal that a bump may break.
2. **Merge the PR into `development`.** Changesets accumulate there until a
   release is cut.
3. **Open a `release:` PR from `development` into `main` and merge it with a
   merge commit, never a squash.** A push to `main` is the release: the
   workflow (`.github/workflows/release.yml`) applies the pending changesets,
   commits the version bump and changelogs, publishes to npm, pushes the tags,
   creates a GitHub Release per published package with that version's
   changelog section as its body, and merges the version commit back into
   `development`. Squashing breaks that last step: the sync merges the version
   commit by hash, and squashed history has no such commit to merge.

Merging into `main` is the irreversible step. A published version cannot be
unpublished, so the release PR is the place to read the changelog entries as a
consumer would.

### After a release

Four things to confirm; the job succeeding is not the same as any of them.

- The Releases page shows a release per published package, each with a body.
- `npm view @canopy-io/node version` and `npm view @canopy-io/nestjs version`
  report the new versions.
- `npm pack @canopy-io/node@latest --dry-run` lists `CHANGELOG.md`.
- `development` carries a `chore(release): sync version packages into
development` commit and its `package.json` versions match `main`.

If the release job fails partway it is safe to re-run: `changeset publish`
skips versions npm already has, and the Release step leaves an existing
release alone. If the sync into `development` is the step that failed, someone
edited a version or changelog on `development` by hand under the release;
merge `main` into `development` by PR and it is back in step.

The version commit carries `[skip ci]`, which is the loop guard: pushing it
back to `main` does not start another release.
