# @canopy-io/nextjs

Sign a Next.js app in on the server through [Canopy](https://canopy-io.com)'s hosted login, and decide what each page shows from the person's permissions, before anything renders.

The session lives in an encrypted, HttpOnly cookie that only your server can read. A page arrives already signed in, with no loading state, and a protected route turns a signed-out visitor away before any HTML is sent. Token verification and the permission checks are [`@canopy-io/node`](https://www.npmjs.com/package/@canopy-io/node)'s; this package connects them to Next.js.

## Install

```bash
npm install @canopy-io/nextjs
```

Next.js 15.5 or 16, App Router, on the Node.js runtime.

## Before the first sign-in

1. In the Developer Console (Integrations → OAuth Clients), register an OAuth client with **Client Type** set to **Confidential**. Add `https://app.example.com/auth/callback` as a redirect URI, and the page sign-out lands on (`https://app.example.com/` by default) as a post-logout redirect URL.
2. Set these environment variables on the server:

```bash
CANOPY_ISSUER=https://auth.canopy-io.com/environments/<environment_id>
CANOPY_CLIENT_ID=<client_id>
CANOPY_CLIENT_SECRET=<client_secret>
CANOPY_APP_URL=https://app.example.com
# Seals the session cookie: at least 32 characters (openssl rand -base64 32).
CANOPY_SECRET=<random secret>
# Only for permission checks at a node: a secret API key from the same Environment.
CANOPY_API_KEY=<secret API key>
```

## Use

```ts
// proxy.ts (Next.js 16)
import { canopyProxy } from "@canopy-io/nextjs";

export default canopyProxy({ protect: ["/reports"] });

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

On Next.js 15.5 the same file is `middleware.ts`, and its `config` adds `runtime: "nodejs"`.

```tsx
// app/reports/page.tsx, a server component
import { auth } from "@canopy-io/nextjs";

export default async function ReportsPage({ team }: { team: { id: string } }) {
  const { user, can } = await auth();

  return (
    <>
      <p>Signed in as {user?.email}</p>
      {(await can("deals.update", { nodeId: team.id })) && (
        <button>Edit</button>
      )}
    </>
  );
}
```

```tsx
// Sign in and out are links to the routes the proxy answers.
<a href="/auth/sign-in?returnTo=/reports">Sign in</a>
<a href="/auth/sign-out">Sign out</a>
```

- `canopyProxy(options)` answers `/auth/sign-in`, `/auth/callback` and `/auth/sign-out` (`routes` renames them). On every other request it opens the session cookie, refreshes the access token shortly before it expires, and sends a signed-out visitor from a `protect`ed path to sign in, coming back to the page they asked for. A string in `protect` covers that path and everything under it; a function decides for itself.
- `auth()` in a server component, route handler or server action returns `isSignedIn`, `userId`, `user` (the ID token's claims, for display), `claims` (the verified access token's), `organization` (`{ orgId, orgRoles, orgScope }`), `accessToken` for calling your own API, and `can(permission, { nodeId })`.
- Sign-out revokes the refresh token, clears the cookie and ends the session at Canopy too, so the next sign-in asks for a password again.

## Client components

Client components receive the session from the server; they hold no token and send no request.

```tsx
// app/layout.tsx
import { auth, clientSession } from "@canopy-io/nextjs";
import { CanopySessionProvider } from "@canopy-io/nextjs/client";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body>
        <CanopySessionProvider session={clientSession(await auth())}>
          {children}
        </CanopySessionProvider>
      </body>
    </html>
  );
}
```

```tsx
"use client";
import { useCanopySession } from "@canopy-io/nextjs/client";

export function Avatar() {
  const { user } = useCanopySession();

  return <span>{user?.name}</span>;
}
```

Pass a permission answer to a client component as a prop: check it with `can()` in the server component that renders it.

## What a request costs

- **A page with a valid session sends nothing to Canopy.** The proxy opens the cookie and reads the expiry, and `auth()` verifies the access token with signing keys read once and cached.
- **A refresh happens once per session, about every 15 minutes.** Requests of one page that arrive together share it. Requests on other instances that refresh at the same moment are all answered with the same new refresh token, so none signs the person out.
- **The commonest checks cost nothing.** A check with no node is answered from the token's `permissions` claim, and a check at the session's organization from `org_permissions`. That needs the `permissions` scope (`scopes` option), which works only on an OAuth client registered with it: a client created with the defaults refuses it with `invalid_scope`.
- **A check at a node reads the identity's grants once,** with `CANOPY_API_KEY`, and holds them for 60 seconds, revalidating with an `ETag` that Canopy answers with an empty `304` when nothing changed. Repeating a check within that time asks nothing new.
- **On a serverless host, the cache lives as long as the instance.** A warm instance behaves like a long-running server: about one grants read a minute per active person. A cold start begins empty and reads the grants and the hierarchy in full, so a host that starts a new instance for every page reads them on every page. Keep instances warm (for example Vercel's Fluid compute, or a minimum instance count) when pages check permissions at nodes.

These checks decide what a page shows. Your API still verifies the access token (`TokenVerifier` in `@canopy-io/node`, with `audience` set to the `client_id`) and authorizes every request it receives.

## License

MIT
