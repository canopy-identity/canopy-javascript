# Single-page app with no backend: `@canopy-io/browser`

A single-page app with no server of its own signs in through Hosted Login as a **public** OAuth client: it has a `client_id` and no secret, and PKCE binds the code to the browser that started the sign-in. `@canopy-io/browser` runs that flow. An app that has a backend uses it instead, as a confidential client or a backend proxy ([choosing.md](choosing.md)): the browser then never holds a token.

## Set up, once per Environment

1. Register the OAuth client with **Client Type** set to **Public** (Console: Integrations → OAuth Clients, or `POST /api/v1/oauth-clients` with `"client_type": "public"`). The type cannot change later. Register the app's callback URL exactly, and the page `signOut()` lands on as a post-logout redirect URL.
2. Add the app's origin, scheme and host only (`https://app.example.com`), to the Environment's **Allowed web origins** (Console: Tenant → Authentication → Sign-in methods, the Environment's row). Without it the browser cannot read Canopy's token responses, and every sign-in fails with `CanopyConnectionError`.

## The whole integration

```ts
import { createCanopyBrowserClient } from "@canopy-io/browser";

declare const signInButton: HTMLButtonElement;
declare const signOutButton: HTMLButtonElement;
declare function showSignedIn(name: string | undefined): void;
declare function showSignedOut(): void;

// The issuer is the Environment's (Console: Authentication → Signing keys).
const canopy = createCanopyBrowserClient({
  issuer: "https://canopy-io.com/environments/<environment_id>",
  clientId: "<public client_id>",
  redirectUri: `${location.origin}/callback`,
  postLogoutRedirectUri: `${location.origin}/`,
  onSessionEnd: () => showSignedOut(),
});

// Once per page load: finishes a sign-in Canopy just answered, or resumes
// Canopy's session without a page (prompt=none) when memory is empty.
const result = await canopy.start();

if (result.status === "signed-in") {
  showSignedIn(canopy.getClaims()?.name);
} else if (result.status === "signed-out" || result.status === "error") {
  // `error.needsSignIn` (login_required, interaction_required) is the normal
  // answer for someone with no Canopy session: show the button, never retry.
  showSignedOut();
}

signInButton.onclick = () => void canopy.signIn();
signOutButton.onclick = () => void canopy.signOut();

// Every call to your API: a current token, refreshed first when it is close
// to expiring; null once the session has ended.
export async function callApi(path: string): Promise<Response> {
  const token = await canopy.getAccessToken();

  if (!token) {
    throw new Error("Signed out");
  }

  return fetch(path, { headers: { Authorization: `Bearer ${token}` } });
}
```

`getClaims<TCustom>()` also reads the Environment's custom claims marked for the ID token, typed and each optional (`canopy.getClaims<{ plan?: string }>()?.plan`): a value that is not stored, or did not fit (`custom_claims_overflow`), is absent. Show them; never authorize from them in the browser.

Your API verifies that access token like any Hosted Login token: `TokenVerifier` with `audience` set to the public `client_id` ([node.md](node.md)). The browser package never verifies signatures; it checks the ID token's issuer, audience and nonce, which is what OpenID Connect asks of a token received straight from the token endpoint.

## What the package does, so the app does not

- Keeps the tokens in memory only. A reload empties memory; `start()` gets new tokens with `prompt=none` while the person's Canopy session lasts, so nothing goes in `localStorage` or `sessionStorage`. `sessionStorage` holds only the PKCE verifier and `nonce` for the round trip, removed when it returns.
- Checks `state` against the sign-in this browser started, and removes `code` and `state` from the address bar.
- Sends one refresh at a time, so the rotated refresh token is never presented twice from the page.
- Signs out of both halves: revokes the refresh token, then sends the browser to the end-session endpoint with the ID token as the hint. Without the second half the next `start()` signs the person straight back in.

## How long a session lasts

A public client's session ends a fixed time after sign-in, however often it refreshes: 30 days by default, 1 to 90 per Environment (**Public app session lifetime**, Console: Tenant → Authentication → Tokens). Then a refresh is refused, `getAccessToken()` answers `null` and `onSessionEnd` fires: show the sign-in button. A refresh replayed from another browser ends that sign-in's session; the person's other sessions keep working.

## Errors

- `CanopyAuthError`: Canopy answered with an OAuth error. Branch on `code`. `needsSignIn` is true for `login_required` and `interaction_required`, the answers to a silent attempt that found no session or needs the person (a second factor, a policy). `state_mismatch` means the URL answered a sign-in this browser did not start: show the sign-in button.
- `CanopyConnectionError`: no response could be read. A browser reports a cross-origin refusal exactly like a network failure, so on a page that has never signed in, check **Allowed web origins** first.

A mobile or desktop app is a public client too, but it opens the authorize URL in the system browser (`ASWebAuthenticationSession`, Custom Tabs) and registers a custom scheme (`com.example.app:/callback`) or a loopback redirect URI; this package is for browsers only.
