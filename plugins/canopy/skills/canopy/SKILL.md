---
name: canopy
description: Integrate Canopy authentication and hierarchical authorization into a JavaScript or TypeScript backend with @canopy-io/node or @canopy-io/nestjs. Use when a project imports @canopy-io/*, calls the Canopy API, verifies Canopy access tokens, checks Canopy roles or permissions, handles Canopy webhooks, or the user mentions Canopy.
license: MIT
---

# Integrating Canopy

Canopy handles sign-in, an organizational hierarchy and role-based access control as a service. An application integrates it in three parts: an end user (an **identity**) signs in and receives an RS256 access token; the backend **verifies** that token locally; the backend **authorizes** each request by asking whether the identity holds a permission at a node of the hierarchy.

Two official packages, both TypeScript, ESM and CommonJS, Node 18 or later:

- `@canopy-io/node`: the client. Calls the API, verifies tokens (`TokenVerifier`), authorizes in-process (`LocalAuthorizer`). Zero runtime dependencies; also runs in browsers, Workers and Deno.
- `@canopy-io/nestjs`: the NestJS integration. `CanopyModule`, `@RequirePermission`, `CanopyGuard`, `CanopyTokenGuard`, `@InjectCanopy()`. Installs `@canopy-io/node`.

Other languages have no SDK: generate a client from `https://canopy-io.com/openapi/api.json`.

## Decide first

Before writing any sign-in code, settle two questions with the user. Getting them wrong only shows up in a real browser on the production domain. [references/choosing.md](references/choosing.md) has the detail.

1. **Who renders the sign-in screen?**
   - **Direct API:** the application renders its own form and calls `/v1/identity/auth/*` with a publishable key (`pk_…`).
   - **Hosted Login:** Canopy renders it; the application is an OAuth 2.0 / OIDC client (authorization code with PKCE).
2. **Where does the refresh token live?** Decided by the publishable key's type and by the domains involved:
   - browser app on the same site as Canopy: nothing to do;
   - browser app on its own domain: a **custom auth domain** (recommended), or a **backend proxy** (BFF) when DNS is out of reach;
   - native or mobile app: a **native** publishable key, which returns the refresh token in the response body.

Then the authorization model: is the Environment **flat**, a **hierarchy**, or does it use **organizations**? That decides what node each check names. See [references/access-models.md](references/access-models.md).

## Rules that are never optional

1. **Verify every token; never decode one.** Use `TokenVerifier` (or `CanopyTokenGuard`). A decoded but unverified token is an open door.
2. **Name the issuer.** Every Environment is its own issuer: pass `environmentId`, or `issuer` on a custom auth domain or self-hosted instance. The verifier refuses to start with neither.
3. **Set `audience` to match the sign-in shape.** A Hosted Login access token carries `aud`, your OAuth `client_id`: pass `audience` so a token minted for another client is refused. A Direct API token carries none: leave `audience` unset. The verifier refuses a token whose `aud` it was not told to check, so the wrong setting fails every request rather than letting one through. Check `claims.type === "identity"` for end users as well.
4. **Authorize locally.** Use `CanopyGuard` or `LocalAuthorizer`, which answer from cached grant roots and the hierarchy. Do not call `canopy.permissions.evaluate` on every request; keep it for the rare decision that must have no staleness.
5. **Fail closed, and keep the failures apart.** `403` means denied. `503` means Canopy could not be reached and nothing was decided: never turn it into a `403`, and never into an allow. `500` means the integration is broken (bad API key, missing scope).
6. **Never send an API key to a browser.** `cnpy_…` keys and the OAuth client secret stay on the server. `pk_…` publishable keys and the `client_id` are public.
7. **Never authorize from the ID token**, never parse the refresh token, and never replay an old refresh token: replay revokes every session the identity holds. Overwrite the stored refresh token on every refresh.
8. **Verify webhook signatures over the raw body**, in constant time. The SDK types deliveries but does not check signatures; see [references/node.md](references/node.md).
9. **Do not log token values**, and do not invent password rules: read `password_policy` from `GET /v1/identity/auth/config`.
10. **Take organization and node context from a verified token or your own data**, never from a header or body the caller controls.

## Where to go next

- NestJS application: [references/nestjs.md](references/nestjs.md)
- Any other Node backend (Express, Fastify, Hono, Next.js route handlers): [references/node.md](references/node.md) and [references/express.md](references/express.md)
- Flat, hierarchy or organizations: [references/access-models.md](references/access-models.md)
- Reviewing existing code: [references/mistakes.md](references/mistakes.md)

## Looking things up

- **Docs MCP server**, no sign-in: `https://canopy-io.com/mcp`. Tools find the page for a task, search the API reference and explain a capability. Prefer it over guessing a route or a setting's location.
- **Full reference as text:** `https://canopy-io.com/llms-full.txt`.
- **API reference:** `https://canopy-io.com/docs/api-reference`; the OpenAPI document is `https://canopy-io.com/openapi/api.json`.
- **Package READMEs:** `@canopy-io/node` and `@canopy-io/nestjs` on npm.

Never guess an endpoint path, a claim name or an error code. Look it up, or ask the user.
