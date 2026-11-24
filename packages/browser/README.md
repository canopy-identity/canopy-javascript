# @canopy-io/browser

Sign a single-page app in through [Canopy](https://canopy-io.com)'s hosted login, with no backend and no secret.

The app registers as a **public** OAuth client: it has a `client_id` and nothing else to keep, and PKCE binds each sign-in to the browser that started it. This package runs that flow and keeps the tokens in memory, out of reach of anything reading `localStorage`. Zero runtime dependencies.

An app that has a backend does not need this package: its server exchanges the code as a confidential client, and the browser never holds a token. Use [`@canopy-io/node`](https://www.npmjs.com/package/@canopy-io/node) there.

## Install

```bash
npm install @canopy-io/browser
```

## Before the first sign-in

1. Register an OAuth client in the Developer Console (Integrations → OAuth Clients) with **Client Type** set to **Public**, your callback URL as a redirect URI, and the page `signOut()` lands on as a post-logout redirect URL.
2. Add your app's origin, such as `https://app.example.com`, to the Environment's **Allowed web origins** (Tenant → Authentication → Sign-in methods). Without it the browser cannot read Canopy's token responses.

## Use

```ts
import { createCanopyBrowserClient } from "@canopy-io/browser";

const canopy = createCanopyBrowserClient({
  issuer: "https://canopy-io.com/environments/<environment_id>",
  clientId: "<public client_id>",
  redirectUri: `${location.origin}/callback`,
  postLogoutRedirectUri: `${location.origin}/`,
  onSessionEnd: () => showSignedOut(),
});

// Once per page load.
const result = await canopy.start();

if (result.status === "signed-in") {
  showSignedIn(canopy.getClaims());
} else if (result.status !== "redirecting") {
  showSignedOut();
}

signInButton.onclick = () => canopy.signIn();
signOutButton.onclick = () => canopy.signOut();

// On every call to your API.
const token = await canopy.getAccessToken();
```

- `start()` finishes a sign-in Canopy has just answered. With nothing in memory (a first visit, a reload) it asks Canopy with `prompt=none`, which returns with tokens while the person's Canopy session lasts and with `login_required` otherwise, and comes back to the page it left: `result.returnTo` is its path, query and hash. Show the sign-in button on `signed-out`, and on `error` (`result.error.needsSignIn` tells the expected answers from a fault). Calls share one run, so calling it twice (React's StrictMode does) exchanges the code once. `start({ resume: false })` finishes a sign-in but never sends the browser to Canopy, for a public page whose visitors should not be bounced through it.
- `signIn({ prompt, organization, loginHint, uiLocales, returnTo })` sends the browser to the hosted sign-in. `uiLocales` names the language the hosted pages are shown in, usually your app's own (`"es"`); left out, the pages follow the person's stored language, then the browser's. `returnTo` comes back on the result.
- `getAccessToken()` returns a current access token, refreshed first when it is within a minute of expiring, or `null` once the session has ended. Concurrent calls share one refresh.
- `getClaims()` returns the ID token's claims: `sub`, and `email` or `name` with those scopes. The Environment's custom claims marked for the ID token are there too; name them to read them typed, each optional: `getClaims<{ plan?: string }>()?.plan`. Show them; never authorize from the ID token.
- `getAccessTokenClaims()` returns the access token's claims: `permissions` with the `permissions` scope, and `org_id`, `org_roles` and `org_permissions` inside an organization, plus custom claims. For display and gating; your API verifies every token.
- `signOut()` revokes the refresh token and sends the browser to Canopy's end-session endpoint, so the next `start()` does not sign the person back in.
- `subscribe(listener)` calls `listener` when the session changes or a permission answer arrives, and returns the function that stops it. `getSnapshot()` returns `{ status, claims, error }`, the same object until something changes: `status` is `loading` until `start()` settles, then `signed-in` or `signed-out`. The client reads no browser global until it is used, so it can be constructed during server rendering.

Your API verifies the access token as it would any Hosted Login token, with `audience` set to the public `client_id` (`TokenVerifier` in `@canopy-io/node`). This package does not verify signatures: it checks the ID token's issuer, audience, nonce and expiry, as OpenID Connect asks of a token received straight from the token endpoint.

## What the person may do

```ts
// One request for every check made in the same tick.
const [canEdit, canExport] = await Promise.all([
  canopy.checkPermission("deals.update", { nodeId: team.id }),
  canopy.checkPermission("deals.export"),
]);

// Without waiting: `loading`, `allowed`, `denied` or `error`.
canopy.getPermissionState("deals.update", { nodeId: team.id });
```

- `checkPermission(permission, { nodeId })` answers whether the signed-in person holds `permission` at `nodeId` (walking its ancestors), or anywhere in the Environment without one. `checkPermissions(checks)` asks several. `listPermissions()` returns every key the person holds anywhere.
- An Environment-wide check is answered from the token's `permissions` claim, and a check at the session's organization from `org_permissions`, with no request, whenever the token carries them (ask for the `permissions` scope). Other checks go to Canopy, those made in the same tick in one request.
- Answers are held until the access token is refreshed (about 15 minutes), the organization changes or the person signs out. Time passing alone sends nothing, and a check already held or on its way is never sent again. A failed check is held for 30 seconds, or as long as `Retry-After` says, before a call may ask again.
- `listOrganizations()` returns the organizations the person belongs to, by name, for an organization switcher (`signIn({ organization })` moves the session into one). It is read once, one request per 100 organizations, and held like an answer; `getOrganizationsState()` reads it without asking.
- These checks decide what a page shows. A permission removed meanwhile can leave a control showing until the token is refreshed; your API still authorizes every request it receives.

## Sessions

A public client's session ends a fixed time after sign-in, however often it refreshes: 30 days by default, set per Environment from 1 to 90 days (**Public app session lifetime**). Then `getAccessToken()` returns `null` and `onSessionEnd` is called.

## CAPTCHA on your own form

A Direct API sign-in page that requires CAPTCHA loads `<canopy-captcha>` from `<api origin>/auth/static/canopy-captcha.js`. This package exports its types (`CanopyCaptchaElement`, and the `canopy-captcha:token` and `canopy-captcha:error` events), so `document.querySelector("canopy-captcha")` is typed once anything is imported from it.

## Errors

- `CanopyAuthError`: Canopy answered with an error. Branch on `code` (`login_required`, `interaction_required`, `invalid_grant`, `state_mismatch`, or a permission check's `rate_limited`); `retryAfterSeconds` says how long a `429` asks to wait.
- `CanopyConnectionError`: no response could be read. A browser reports a cross-origin refusal the same way as a network failure; on a page that has never signed in, check **Allowed web origins**.

Full guide: [Hosted Login, single-page and mobile apps](https://canopy-io.com/docs/authentication/hosted-login#single-page-and-mobile-apps).

## License

MIT
