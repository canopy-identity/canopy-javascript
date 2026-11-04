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

- `start()` finishes a sign-in Canopy has just answered. With nothing in memory (a first visit, a reload) it asks Canopy with `prompt=none`, which returns with tokens while the person's Canopy session lasts and with `login_required` otherwise. Show the sign-in button on `signed-out`, and on `error` (`result.error.needsSignIn` tells the expected answers from a fault).
- `signIn({ prompt, organization, loginHint, returnTo })` sends the browser to the hosted sign-in. `returnTo` comes back on the result.
- `getAccessToken()` returns a current access token, refreshed first when it is within a minute of expiring, or `null` once the session has ended. Concurrent calls share one refresh.
- `getClaims()` returns the ID token's claims: `sub`, and `email` or `name` with those scopes. The Environment's custom claims marked for the ID token are there too; name them to read them typed, each optional: `getClaims<{ plan?: string }>()?.plan`. Show them; never authorize from the ID token.
- `signOut()` revokes the refresh token and sends the browser to Canopy's end-session endpoint, so the next `start()` does not sign the person back in.

Your API verifies the access token as it would any Hosted Login token, with `audience` set to the public `client_id` (`TokenVerifier` in `@canopy-io/node`). This package does not verify signatures: it checks the ID token's issuer, audience, nonce and expiry, as OpenID Connect asks of a token received straight from the token endpoint.

## Sessions

A public client's session ends a fixed time after sign-in, however often it refreshes: 30 days by default, set per Environment from 1 to 90 days (**Public app session lifetime**). Then `getAccessToken()` returns `null` and `onSessionEnd` is called.

## Errors

- `CanopyAuthError`: Canopy answered with an OAuth error. Branch on `code` (`login_required`, `interaction_required`, `invalid_grant`, `state_mismatch`).
- `CanopyConnectionError`: no response could be read. A browser reports a cross-origin refusal the same way as a network failure; on a page that has never signed in, check **Allowed web origins**.

Full guide: [Hosted Login, single-page and mobile apps](https://canopy-io.com/docs/authentication/hosted-login#single-page-and-mobile-apps).

## License

MIT
