# Canopy SDKs for JavaScript

The official JavaScript and TypeScript client libraries for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

This repository is the whole family. Each package is published independently to npm under the `@canopy-io` scope, and each has its own README describing what it does.

## Packages

| Package                                    | What it is                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **[`@canopy-io/node`](packages/node)**     | The server client. Calls the API, verifies access tokens, and has zero runtime dependencies.                         |
| **[`@canopy-io/nestjs`](packages/nestjs)** | The NestJS integration. Wraps the client in a module and turns an authorization check into a decorator on the route. |

`@canopy-io/nestjs` depends on `@canopy-io/node` and installs it for you. A NestJS application needs only the integration package; anything else needs the client.

## What they have in common

Everything here is TypeScript, ships both ESM and CommonJS, and requires Node 18 or later.

Every request and response type is generated from the same [OpenAPI document](https://canopy-io.com/openapi/api.json) that renders Canopy's API reference, and CI fails when the committed types no longer match it — so a package cannot silently describe an API that has moved on.

These are the only official SDKs. That specification is published so a generator can produce a client for Python, Go, or anything else, which serves those languages better than a partly-maintained SDK would.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing, and releasing.

## License

MIT © Canopy Identity Inc.
