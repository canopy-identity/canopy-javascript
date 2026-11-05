---
name: canopy
description: Integrate Canopy authentication and hierarchical authorization into a JavaScript or TypeScript app: a backend with @canopy-io/node or @canopy-io/nestjs, or a single-page app with no backend with @canopy-io/browser. Use when a project imports @canopy-io/*, calls the Canopy API, verifies Canopy access tokens, checks Canopy roles or permissions, handles Canopy webhooks, or the user mentions Canopy.
license: MIT
---

# Integrating Canopy

Canopy handles sign-in, an organizational hierarchy and role-based access control as a service. An application integrates it in three parts: an end user (an **identity**) signs in and receives an RS256 access token; the backend **verifies** that token locally; the backend **authorizes** each request by asking whether the identity holds a permission at a node of the hierarchy.

Three official packages, all TypeScript, ESM and CommonJS:

- `@canopy-io/node`: the client. Calls the API, verifies tokens (`TokenVerifier`), authorizes in-process (`LocalAuthorizer`). Zero runtime dependencies; also runs in browsers, Workers and Deno.
- `@canopy-io/nestjs`: the NestJS integration. `CanopyModule`, `@RequirePermission`, `CanopyGuard`, `CanopyTokenGuard`, `@InjectCanopy()`. Installs `@canopy-io/node`.
- `@canopy-io/browser`: sign-in for a single-page app with no backend, as a public OAuth client through Hosted Login. `createCanopyBrowserClient`; tokens in memory. Zero runtime dependencies.

The first two need Node 18 or later.

Other languages have no SDK: generate a client from `https://canopy-io.com/openapi/api.json`.

## Decide first

Before writing any sign-in code, settle two questions with the user. Getting them wrong only shows up in a real browser on the production domain. [references/choosing.md](references/choosing.md) has the detail.

1. **Who renders the sign-in screen?**
   - **Direct API:** the application renders its own form and calls `/v1/identity/auth/*` with a publishable key (`pk_…`).
   - **Hosted Login:** Canopy renders it; the application is an OAuth 2.0 / OIDC client (authorization code with PKCE). A **confidential** client when a backend exchanges the code; a **public** client, with no secret, for a single-page app with no backend (`@canopy-io/browser`, [references/spa.md](references/spa.md)) or a mobile app.
   - Social sign-in (Google, GitHub, Microsoft, Apple, or an OpenID Connect provider) works on both: the Environment enables each provider in the Console, Hosted Login shows it as a button, and a Direct API app sends the browser to Canopy's start URL. Never build a provider's OAuth flow beside Canopy.
   - Passkey sign-in works on both too, where the Environment turns it on: Hosted Login shows **Sign in with a passkey**, and a Direct API app runs the browser ceremony against Canopy's `login/passkey/options` and `/verify`. The passkey is both factors. Never register or verify passkeys in the application beside Canopy.
2. **Where does the refresh token live?** Decided by the publishable key's type and by the domains involved:
   - browser app on the same site as Canopy: nothing to do;
   - browser app on its own domain: a **custom auth domain** (recommended), or a **backend proxy** (BFF) when DNS is out of reach;
   - native or mobile app: a **native** publishable key, which returns the refresh token in the response body.

Then the authorization model: is the Environment **flat**, a **hierarchy**, or does it use **organizations**? That decides what node each check names. See [references/access-models.md](references/access-models.md).

## Rules that are never optional

1. **Verify every token; never decode one.** Use `TokenVerifier` (or `CanopyTokenGuard`). A decoded but unverified token is an open door.
2. **Name the issuer.** Every Environment is its own issuer: pass `environmentId`, or `issuer` on a custom auth domain or self-hosted instance (a self-hosted instance can instead set `CANOPY_BASE_URL` for the process). The verifier refuses to start with neither.
3. **Set `audience` to match the sign-in shape.** A Hosted Login access token carries `aud`, your OAuth `client_id`: pass `audience` so a token minted for another client is refused. A Direct API token carries none: leave `audience` unset. The verifier refuses a token whose `aud` it was not told to check, so the wrong setting fails every request rather than letting one through. The verifier accepts identity tokens only; add `allowedTypes` only for a backend that must accept Canopy's own administrator tokens. A machine client's `client_credentials` token (`type: "service"`) is admitted per route, never verifier-wide: `verify(token, { alsoAllow: ["service"] })`, or `@AllowServiceTokens()` in NestJS. Its `aud` names the API, so set `serviceAudience` to the audience the API answers to. A machine client acting for a person after a token exchange (`type: "delegated"`) is admitted the same way, with `alsoAllow: ["delegated"]` or `@AllowDelegatedTokens()`, and authorized with both principals.
4. **Authorize locally.** Use `CanopyGuard` or `LocalAuthorizer`, which answer from cached grant roots and the hierarchy. Do not call `canopy.permissions.evaluate` on every request; keep it for the rare decision that must have no staleness.
5. **Fail closed, and keep the failures apart.** `403` means denied. `503` means Canopy could not be reached and nothing was decided: never turn it into a `403`, and never into an allow. `500` means the integration is broken (bad API key, missing scope). Outside NestJS, `tokenErrorStatus` and `authorizationErrorStatus` give the status for a failed verification or check.
6. **Never send an API key to a browser.** `cnpy_…` keys and the OAuth client secret stay on the server. `pk_…` publishable keys and the `client_id` are public.
7. **Never authorize from the ID token**, never parse the refresh token, and never replay an old refresh token: through the Direct API a replay revokes every session the identity holds, and through Hosted Login it ends that sign-in's session (every token descended from it). Overwrite the stored refresh token on every refresh.
8. **Verify webhook signatures over the raw body** with `verifyWebhookSignature`, never a hand-written check, then pass the delivery to `authorizer.applyEvent` so a revocation does not wait out the cache. See [references/node.md](references/node.md).
9. **Do not log token values**, and do not invent password rules: read `password_policy` from `GET /v1/identity/auth/config`.
10. **Take organization and node context from a verified token or your own data**, never from a header or body the caller controls.
11. **Bind a redirect sign-in's `state` to the browser that started it.** For a social or SSO sign-in through the Direct API, keep the `state` in an httpOnly cookie (or that browser's own session) and compare on return; a server-side list of pending states lets an attacker sign someone else in as themselves.

## Where to go next

- NestJS application: [references/nestjs.md](references/nestjs.md)
- Any other Node backend (Express, Fastify, Hono, Next.js route handlers): [references/node.md](references/node.md) and [references/express.md](references/express.md)
- Single-page app with no backend: [references/spa.md](references/spa.md)
- Flat, hierarchy or organizations: [references/access-models.md](references/access-models.md)
- Giving an agent a credential, or letting one act for a person: [references/choosing.md](references/choosing.md), "Which credential an agent holds"
- Reviewing existing code: [references/mistakes.md](references/mistakes.md)

## Looking things up

- **Docs MCP server**, no sign-in: `https://canopy-io.com/mcp`. Tools find the page for a task, search the API reference and explain a capability. Prefer it over guessing a route or a setting's location.
- **Full reference as text:** `https://canopy-io.com/llms-full.txt`.
- **API reference:** `https://canopy-io.com/docs/api-reference`; the OpenAPI document is `https://canopy-io.com/openapi/api.json`.
- **Package READMEs:** `@canopy-io/node`, `@canopy-io/nestjs` and `@canopy-io/browser` on npm.

Never guess an endpoint path, a claim name or an error code. Look it up, or ask the user.

## How this skill is checked

Every TypeScript block in the references compiles against the packages it ships with (`npm run check:skill` in this repository), and the Canopy repository assembles the blocks of `nestjs.md`, `express.md` and `node.md` into running applications against a live Canopy on every pull request and release, asserting the statuses they claim. A block that stops being true fails there before it ships.
