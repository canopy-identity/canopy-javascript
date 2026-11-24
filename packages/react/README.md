# @canopy-io/react

Sign a React single-page app in through [Canopy](https://canopy-io.com)'s hosted login, and decide what it shows from the person's permissions.

A provider, hooks and components over [`@canopy-io/browser`](https://www.npmjs.com/package/@canopy-io/browser), which does the work: the sign-in as a public OAuth client, tokens in memory, refresh, and the permission checks with their batching and held answers. This package only maps that client into React. It renders no UI of its own; Canopy's hosted pages show sign-in, second factors, SSO and passkeys.

## Install

```bash
npm install @canopy-io/react
```

React 18 or 19. `@canopy-io/browser` comes with it, and everything it exports is exported from here too.

## Before the first sign-in

1. Register an OAuth client in the Developer Console (Integrations → OAuth Clients) with **Client Type** set to **Public**, your callback URL as a redirect URI, and the page `signOut()` lands on as a post-logout redirect URL.
2. Add your app's origin, such as `https://app.example.com`, to the Environment's **Allowed web origins** (Tenant → Authentication → Sign-in methods). Without it the browser cannot read Canopy's token responses.

## Use

```tsx
import { CanopyProvider } from "@canopy-io/react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <CanopyProvider
    issuer="https://canopy-io.com/environments/<environment_id>"
    clientId="<public client_id>"
    redirectUri={`${location.origin}/callback`}
    postLogoutRedirectUri={`${location.origin}/`}
    scopes={["openid", "email", "permissions"]}
  >
    <App />
  </CanopyProvider>,
);
```

```tsx
import { Can, SignedIn, SignedOut, useAuth, useUser } from "@canopy-io/react";

function Header() {
  const { signIn, signOut } = useAuth();
  const user = useUser();

  return (
    <header>
      <SignedOut>
        <button onClick={() => signIn()}>Sign in</button>
      </SignedOut>
      <SignedIn>
        {user?.email}
        <button onClick={() => signOut()}>Sign out</button>
      </SignedIn>
    </header>
  );
}

function Deal({ deal }: { deal: { id: string; teamId: string } }) {
  return (
    <Can permission="deals.update" nodeId={deal.teamId}>
      <button>Edit</button>
    </Can>
  );
}
```

- `<CanopyProvider>` takes the browser client's options, or `client={...}` with one you created to share with code outside React. It starts the client once (twice under StrictMode is fine: the runs are shared): it finishes a sign-in Canopy has just answered, or resumes the session silently with `prompt=none`. `resume={false}` finishes a sign-in but never sends a visitor to Canopy, for public pages.
- After a sign-in the person comes back to the page they started on. Pass `onRedirectCallback={(returnTo) => navigate(returnTo, { replace: true })}` so your router goes there; without it the provider replaces the address through `history`, which a router does not see.
- The provider does nothing during server rendering: the client is created without touching a browser global, and it starts in an effect.

## Hooks

- `useAuth()`: `{ status, isLoading, isSignedIn, userId, orgId, getAccessToken, signIn, signOut, error }`. `status` is `loading` until the provider knows, then `signed-in` or `signed-out`.
- `useUser<TCustom>()`: the ID token's claims, or `null`. Name the Environment's custom claims marked for the ID token to read them typed: `useUser<{ plan?: string }>()?.plan`. Show them; never authorize from them.
- `useAccessToken()`: a function returning a current access token for `Authorization: Bearer`, refreshed first when it is about to expire. It is the same function for the provider's lifetime.
- `useAccessTokenClaims<TCustom>()`: the access token's claims (`permissions`, `org_id`, `org_roles`, `org_permissions`, custom claims), re-rendering when the token changes.
- `useOrganization()`: `{ orgId, orgRoles, orgScope, switchOrganization }`. `switchOrganization(id)` is a sign-in round trip into that organization that comes back to the current page.
- `useOrganizationList()`: `{ organizations, isLoading, error }`, the organizations the person belongs to, by name, for a switcher. Read once and held like a permission answer, until the token changes.
- `usePermission(permission, { nodeId })`: `{ allowed, isLoading, error }` for whether the person holds `permission` at `nodeId` (walking its ancestors), or anywhere in the Environment without one. `usePermissions(checks)` asks several and answers in their order.

## Components

- `<SignedIn>` and `<SignedOut>` render their children for a signed-in person, and once the provider knows nobody is signed in. Neither renders while it is still finding out, so a sign-in button does not flash.
- `<RequireAuth fallback={...}>` renders its children for a signed-in person and sends anyone else to Canopy's sign-in, coming back to the same page.
- `<Can permission nodeId fallback={...}>` renders its children when the person holds the permission, and the fallback otherwise.

## What a permission check costs

The checks are the browser client's: an Environment-wide check is answered from the token's `permissions` claim, and a check at the session's organization from `org_permissions`, with no request, whenever the token carries them (ask for the `permissions` scope). Other checks go to Canopy, all those from one render in one request. Answers are held until the access token is refreshed (about 15 minutes), the organization changes or the person signs out; rendering again asks nothing new.

`allowed` is `false` until the answer arrives and on an error, so nothing appears that the person cannot use. A failed check is held for 30 seconds, or as long as `Retry-After` says, before a render asks again.

These checks decide what a page shows. A permission removed meanwhile can leave a control showing until the token is refreshed; your API still verifies the access token (`TokenVerifier` in `@canopy-io/node`, with `audience` set to the public `client_id`) and authorizes every request it receives.

## Errors

`useAuth().error` is Canopy's last refusal (`CanopyAuthError`; `error.needsSignIn` means show the sign-in button), or a `CanopyConnectionError` when Canopy could not be reached at all. A browser reports a cross-origin refusal the same way as a network failure; on a page that has never signed in, check **Allowed web origins**. A permission check's error is on its own result.

Full guide: [Hosted Login, single-page and mobile apps](https://canopy-io.com/docs/authentication/hosted-login#single-page-and-mobile-apps).

## License

MIT
