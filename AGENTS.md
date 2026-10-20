# AGENTS.md

Guidance for AI coding agents.

## Integrating Canopy into an application

Use the Canopy agent skill in [`plugins/canopy/skills/canopy/`](plugins/canopy/skills/canopy/SKILL.md). It covers choosing a sign-in shape, verifying tokens, authorizing with `@canopy-io/nestjs` or `@canopy-io/node`, the access models, webhooks, and the mistakes to avoid. Start with `SKILL.md`; it links the rest.

## Working in this repository

- npm workspaces: `packages/node` (`@canopy-io/node`) and `packages/nestjs` (`@canopy-io/nestjs`). `CONTRIBUTING.md` covers building, testing and releasing.
- `npm run verify` builds, lints, typechecks, checks the generated types against the published spec, compiles every code block in the skill (`npm run check:skill`) and runs the tests.
- `src/generated/types.ts` is generated from the published OpenAPI document; never edit it by hand (`npm run generate`).
- `@canopy-io/node` has zero runtime dependencies, and CI enforces it.
- Every change to a published package carries a changeset (`npm run changeset`).
- When the SDK's behaviour or options change, update the skill in the same pull request: its code blocks must keep compiling, and its rules must stay true.
