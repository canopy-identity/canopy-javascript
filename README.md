# Canopy SDKs for JavaScript

The official JavaScript and TypeScript client libraries for [Canopy](https://canopy-io.com) — hierarchical identity and access management for B2B SaaS.

This repository is the whole family. Each package is published independently to npm under the `@canopy-io` scope, and each has its own README describing what it does.

## Packages

| Package                                      | What it is                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[`@canopy-io/node`](packages/node)**       | The server client. Calls the API, verifies access tokens, and has zero runtime dependencies.                                                                                                                       |
| **[`@canopy-io/nestjs`](packages/nestjs)**   | The NestJS integration. Wraps the client in a module and turns an authorization check into a decorator on the route.                                                                                               |
| **[`@canopy-io/browser`](packages/browser)** | The browser client. Signs a single-page app in through Canopy's hosted login as a public OAuth client, with PKCE and tokens kept in memory.                                                                        |
| **[`@canopy-io/react`](packages/react)**     | The React SDK. A provider, hooks and components over `@canopy-io/browser`: the session, the access token, the organization, and permission checks that decide what renders.                                        |
| **[`@canopy-io/angular`](packages/angular)** | The Angular SDK. Providers, signals, a route guard, an HTTP interceptor and directives over `@canopy-io/browser`: the session, the access token, the organization, and permission checks that decide what renders. |
| **[`@canopy-io/nextjs`](packages/nextjs)**   | The Next.js SDK. Signs an App Router app in on the server as a confidential client, keeps the session in an encrypted cookie, and checks permissions in server components with `auth()`, over `@canopy-io/node`.   |

`@canopy-io/nestjs` and `@canopy-io/nextjs` depend on `@canopy-io/node` and install it for you. A NestJS or Next.js application needs only its integration package; anything else on a server needs the client.

## What they have in common

Everything here is TypeScript and ships both ESM and CommonJS. The server packages require Node 18 or later; `@canopy-io/browser` runs in any browser with the Web Crypto API, `@canopy-io/react` with React 18 or 19, `@canopy-io/angular` with Angular 20, 21 or 22, and `@canopy-io/nextjs` with Next.js 15.5 or 16 on the Node.js runtime.

Every request and response type is generated from the same [OpenAPI document](https://canopy-io.com/openapi/api.json) that renders Canopy's API reference, and CI fails when the committed types no longer match it — so a package cannot silently describe an API that has moved on.

These are the only official SDKs. That specification is published so a generator can produce a client for Python, Go, or anything else, which serves those languages better than a partly-maintained SDK would.

## For AI coding assistants

The Canopy agent skill, in [canopy-identity/canopy-plugins](https://github.com/canopy-identity/canopy-plugins), teaches an assistant to integrate Canopy correctly: which sign-in shape to choose, verifying tokens, authorizing locally, failing closed, and the mistakes to avoid. Every code block in it is compiled against these packages as published.

In Claude Code:

```
/plugin marketplace add canopy-identity/canopy-plugins
/plugin install canopy@canopy
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing, and releasing.

## License

MIT © Canopy Identity Inc.
