# @canopy-io/angular

Sign an Angular single-page app in through [Canopy](https://canopy-io.com)'s hosted login, and decide what it shows from the person's permissions.

Providers, signals, a route guard, an HTTP interceptor and structural directives over [`@canopy-io/browser`](https://www.npmjs.com/package/@canopy-io/browser), which does the work: the sign-in as a public OAuth client, tokens in memory, refresh, and the permission checks with their batching and held answers. This package only maps that client into Angular. It renders no UI of its own; Canopy's hosted pages show sign-in, second factors, SSO and passkeys.

## Install

```bash
npm install @canopy-io/angular
```

Angular 20, 21 or 22, standalone APIs. `@canopy-io/browser` comes with it, and everything it exports is exported from here too.

## Before the first sign-in

1. Register an OAuth client in the Developer Console (Integrations → OAuth Clients) with **Client Type** set to **Public**, your callback URL as a redirect URI, and the page `signOut()` lands on as a post-logout redirect URL.
2. Add your app's origin, such as `https://app.example.com`, to the Environment's **Allowed web origins** (Tenant → Authentication → Sign-in methods). Without it the browser cannot read Canopy's token responses.

## Use

```ts
// app.config.ts
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import type { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { canopyAuthInterceptor, provideCanopy } from "@canopy-io/angular";

import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideCanopy({
      issuer: "https://canopy-io.com/environments/<environment_id>",
      clientId: "<public client_id>",
      redirectUri: `${location.origin}/callback`,
      postLogoutRedirectUri: `${location.origin}/`,
      // The token is attached to these origins and to no other.
      apiOrigins: ["https://api.example.com"],
    }),
    provideHttpClient(withInterceptors([canopyAuthInterceptor])),
  ],
};
```

```ts
// app.routes.ts
import type { Routes } from "@angular/router";
import { canopyAuthGuard } from "@canopy-io/angular";

export const routes: Routes = [
  {
    path: "reports",
    canActivate: [canopyAuthGuard],
    loadComponent: () => import("./reports"),
  },
];
```

```ts
import { Component, inject, input } from "@angular/core";
import {
  CanopyAuth,
  CanopyCanDirective,
  CanopySignedInDirective,
  CanopySignedOutDirective,
} from "@canopy-io/angular";

@Component({
  selector: "app-deal",
  imports: [
    CanopyCanDirective,
    CanopySignedInDirective,
    CanopySignedOutDirective,
  ],
  template: `
    <button *canopySignedOut (click)="auth.signIn()">Sign in</button>
    <p *canopySignedIn>{{ auth.user()?.email }}</p>

    <button *canopyCan="'deals.update'; nodeId: teamId(); else: readOnly">
      Edit
    </button>
    <ng-template #readOnly><span>Read only</span></ng-template>
  `,
})
export class DealComponent {
  readonly auth = inject(CanopyAuth);
  readonly teamId = input.required<string>();
}
```

- `provideCanopy(options)` takes the browser client's options, or `client` with one you created to share with code outside Angular. Before the first navigation it starts the client once: it finishes a sign-in Canopy has just answered, or resumes the session silently with `prompt=none`, and puts the page the sign-in started on in the address bar, so the router's first navigation lands there. `resume: false` finishes a sign-in but never sends a visitor to Canopy, for public apps. On the server it does nothing.
- `canopyAuthGuard` admits a signed-in person and sends anyone else to Canopy's sign-in, coming back to the page they were opening.
- `canopyAuthInterceptor` attaches `Authorization: Bearer` to requests for the origins in `apiOrigins`, refreshing the token first when it is about to expire, and to no other origin. A request that already carries `Authorization` is left as it is.

## Signals

`CanopyAuth`, injectable anywhere:

- `status()`: `loading` until the session is known, then `signed-in` or `signed-out`; `isLoading()` and `isSignedIn()`.
- `user()`: the ID token's claims, or `null`. Show them; never authorize from them.
- `organization()`: `{ orgId, orgRoles, orgScope }` from the access token; `accessTokenClaims()` for the rest.
- `error()`: Canopy's last refusal (`CanopyAuthError`; `error.needsSignIn` means show the sign-in button), or a `CanopyConnectionError` when Canopy could not be reached at all. A browser reports a cross-origin refusal the same way as a network failure; on a page that has never signed in, check **Allowed web origins**.
- `signIn()`, `signOut()`, `getAccessToken()`, and `switchOrganization(id)`, a sign-in round trip into that organization that comes back to the current page.
- `organizationList()`: a signal of `{ organizations, isLoading, error }`, the organizations the person belongs to, by name, for a switcher.

`CanopyPermissions.can(permission, { nodeId })` returns a signal of `{ allowed, isLoading, error }`: whether the person holds `permission` at `nodeId` (walking its ancestors), or anywhere in the Environment without one. The same check returns the same signal.

## Directives

- `*canopyCan="'deals.write'; nodeId: id; else other"` renders its content when the person holds the permission, and the `else` template otherwise.
- `*canopySignedIn` (with an optional `else`) and `*canopySignedOut`. Neither renders while the session loads, so a sign-in button does not flash.

## What a permission check costs

The checks are the browser client's: an Environment-wide check is answered from the token's `permissions` claim, and a check at the session's organization from `org_permissions`, with no request, whenever the token carries them. That needs the `permissions` scope, which works only on an OAuth client registered with it: a client with the default scopes refuses it with `invalid_scope`. Other checks go to Canopy, all those made together in one request. Answers are held until the access token is refreshed (about 15 minutes), the organization changes or the person signs out; reading a signal again or running change detection asks nothing new.

`allowed` is `false` until the answer arrives and on an error, so nothing appears that the person cannot use. A failed check is held for 30 seconds, or as long as `Retry-After` says, before it is asked again.

These checks decide what a page shows. A permission removed meanwhile can leave a control showing until the token is refreshed; your API still verifies the access token (`TokenVerifier` in `@canopy-io/node`, with `audience` set to the public `client_id`) and authorizes every request it receives.

Full guide: [Hosted Login, single-page and mobile apps](https://canopy-io.com/docs/authentication/hosted-login#single-page-and-mobile-apps).

## License

MIT
