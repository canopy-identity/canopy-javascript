# @canopy-io/node

```bash
npm install @canopy-io/node
```

## The client

Server-to-server calls use an API key (`cnpy_…`), never shipped to a browser. Responses come back unwrapped, lists page with `for await`, and errors carry a stable `code`.

```ts
import { Canopy, isCanopyError } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });

export async function grant(
  identityId: string,
  nodeId: string,
  roleId: string,
) {
  try {
    await canopy.assignments.create({
      identity_id: identityId,
      node_id: nodeId,
      role_id: roleId,
    });
  } catch (error) {
    // Branch on the code, never on the message.
    if (isCanopyError(error) && error.code === "rbac.assignment_conflict") {
      return;
    }

    throw error;
  }
}

export async function listEmails(): Promise<string[]> {
  const emails: string[] = [];

  for await (const identity of canopy.identities.list({ take: 50 })) {
    emails.push(identity.email);
  }

  return emails;
}
```

Anything without a typed wrapper goes through `canopy.client.request`, with the same envelope handling, errors and retries:

```ts
import { Canopy } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });

export const recentEvents = () =>
  canopy.client.request("GET", "/api/v1/audit-events", {
    query: { limit: 50 },
  });
```

The client retries only what is safe to replay (idempotent methods on `5xx`, and any `429`). Do not wrap it in your own retry loop.

Lists are paged: `{ items, pagination }`, 20 per page by default and at most 100 (`take`). Every list wrapper returns a `Paginator` (`for await`, `.all()`, `.first()`), including `identities.sessions` and `organizations.listDirectoryGroups`. A list read through `canopy.client.request`, such as `GET /api/v1/nodes`, answers one page; walk it with `paginate` rather than reading the first page as the whole. `permissions.evaluateBulk` takes 1 to 100 checks and refuses more with a `400`.

## Verifying an access token

One fetch of the signing keys, then every verification is local. Name the Environment, and name your client when the tokens come from Hosted Login: those carry `aud`, your OAuth `client_id`, and the verifier refuses a token whose `aud` it was not told to check. Direct API tokens carry none, so leave `audience` out for them.

```ts
import {
  TokenVerifier,
  tokenErrorStatus,
  type CanopyTokenClaims,
} from "@canopy-io/node";

// One verifier per process: it caches the key set. It accepts identity tokens
// only (your end users); admin, staff and API-key tokens are refused.
const verifier = new TokenVerifier({
  environmentId: process.env.CANOPY_ENVIRONMENT_ID ?? "",
  // Hosted Login: your OAuth client id. Direct API: leave this out.
  audience: process.env.CANOPY_OAUTH_CLIENT_ID,
});

export async function authenticate(
  authorization: string | undefined,
): Promise<CanopyTokenClaims | null> {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  if (!token) {
    return null;
  }

  try {
    return await verifier.verify(token);
  } catch (error) {
    // 401 for the token's own faults (expired, bad signature, wrong issuer),
    // 503 when the keys could not be read. error.code is for your logs.
    if (tokenErrorStatus(error).status === 401) {
      return null;
    }

    throw error;
  }
}
```

- On a custom auth domain or self-hosted instance, pass `issuer` (for example `https://auth.acme.com`) instead of `environmentId`.
- Pre-auth tokens (issued before an administrator picks an Account) are refused by default. Leave it that way.
- `claims.amr` says how the session was proven (`pwd`, `otp`, `sso`, plus `mfa` after a second factor). Require `claims.amr?.includes("mfa")` before a sensitive action if the product needs it.
- With organizations on, read the organization through `orgContext(claims)`, which returns `{ orgId, orgRoles, orgRoleIds, staff }` or `null`, rather than off the raw claims. `orgRoles` is empty for a member holding no role at the organization node; authorize by evaluating, not by the list. `staff` is true for the developer's own staff (a role at the Environment root, `org_scope: "all"` on the token) inside a customer's organization: show it, since the organization sees each entry in its staff activity.

## Machine clients

A machine client (an OAuth client registered with `client_kind: machine`) is a principal of its own: it holds roles and obtains tokens for itself with the `client_credentials` grant. Its token has `type: "service"` and `sub` set to its `client_id`. Admit it only where machines are expected, and authorize it from its own grants with `principal_type: "service"`:

```ts
import {
  Canopy,
  LocalAuthorizer,
  TokenVerifier,
  type CanopyTokenClaims,
} from "@canopy-io/node";

const verifier = new TokenVerifier({
  environmentId: process.env.CANOPY_ENVIRONMENT_ID,
  // The audience this API answers to, which a service token's `aud` names.
  serviceAudience: "https://api.example.com",
});
const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
const authorizer = new LocalAuthorizer(canopy.client);

export async function mayImportOrders(
  token: string,
  nodeId: string,
): Promise<boolean> {
  // Only this route widens the verifier; everywhere else a service token is refused.
  const claims: CanopyTokenClaims = await verifier.verify(token, {
    alsoAllow: ["service"],
  });

  const { allowed } = await authorizer.evaluate({
    identity_id: claims.sub,
    principal_type: claims.type === "service" ? "service" : "identity",
    permission: "orders.import",
    node_id: nodeId,
  });

  return allowed;
}
```

- A client's grants are read from `GET /api/v1/oauth-clients/:id/grants` and cached apart from people's. `applyEvent` invalidates one from the `client_id` an assignment webhook carries in `data.metadata.client_id`; by hand, `authorizer.invalidate(clientId, { principalType: "service" })`.
- Never take the principal type from the request: read it off the verified claims.
- Without `serviceAudience` a service token is refused (`token.audience_unverified`); one minted for another API answers `token.audience_mismatch`.

## Authorizing in-process

`LocalAuthorizer` asks Canopy "where may this identity act" once, then answers each check in-process by walking up the hierarchy. Keep one instance per process.

```ts
import { Canopy, LocalAuthorizer } from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
const authorizer = new LocalAuthorizer(canopy.client);

export async function mayViewReports(
  identityId: string,
  nodeId: string,
): Promise<boolean> {
  // A grant at a parent node covers every node beneath it.
  const { allowed } = await authorizer.evaluate({
    identity_id: identityId,
    permission: "reports.view",
    node_id: nodeId,
  });

  return allowed;
}
```

- `scope` defaults to `node`; a `node` check without `node_id` is denied. Use `scope: "app_wide"` only for "holds it anywhere", such as showing a menu item.
- A denial carries `reason` (`permission_not_held`, `outside_grants`, `expired`, `not_yet_effective`, `denied`, `node_missing`). `denied` is a deny at the node or above it: it refuses whatever the grants allow, and no grant beneath it undoes it. `onDecision` / `onDenied` options hear every verdict after it is reached; they are never awaited and cannot change it.
- To filter a list, do not call `evaluate` per row. `authorizer.accessibleNodes(identityId, permission)` gives the node ids the identity may see as a `Set` for an `IN (...)` filter (`nodes: null, complete: false` past `maxNodes`; `envWide: true` means no filter at all), and `authorizer.grantRoots(...)` gives the roots for a closure-table or path filter. Both name `excludedRoots`, the subtrees a deny cuts out from under a root: a roots filter must exclude them too. `authorizer.permissionsAt(identityId, nodeId)` lists what someone holds at one node, and `permissionsAtMany(identityId, nodeIds)` several nodes from one read. All three answer from the same cache as a check. The write that follows still checks its node.
- For a menu inside an organization, `authorizer.holdsAnywhereUnder(identityId, permission, orgId)` answers whether the permission is held at the organization or anywhere beneath it (`{ held, roots, excludedRoots }`). `app_wide` cannot, since it covers the whole Environment. It is a read for menus, never a guard: the write checks its own node.
- Answers are cached for at most 60 seconds (`ttlMs`, up to 300 000). That is the revocation delay unless webhooks reach `applyEvent` (see Webhooks). Use `canopy.permissions.evaluate` for a decision that must be fresh.
- A scoped API key needs `identity.view` and `hierarchy.view`. Without `hierarchy.view`, node checks throw `CanopyAuthorizerError` instead of answering `false`: treat that as a broken integration (`500`), not a denial.
- Mapping failures to HTTP statuses: see [express.md](express.md).

## Webhooks

Check every delivery with `verifyWebhookSignature` before acting on it, over the body exactly as it arrived, then pass it to `authorizer.applyEvent` so a revocation reaches the next local check instead of waiting out `ttlMs`. Never hand-write the HMAC check.

```ts
import express from "express";
import {
  isWebhookEvent,
  LocalAuthorizer,
  verifyWebhookSignature,
  type WebhookDelivery,
} from "@canopy-io/node";

declare const app: express.Express;
declare const authorizer: LocalAuthorizer;
declare const webhookSecret: string;

app.post(
  "/webhooks/canopy",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const valid = await verifyWebhookSignature({
      headers: req.headers,
      rawBody: req.body as Buffer,
      secret: webhookSecret,
    });

    if (!valid) {
      res.sendStatus(401);

      return;
    }

    const delivery = JSON.parse(
      (req.body as Buffer).toString(),
    ) as WebhookDelivery;

    authorizer.applyEvent(delivery);

    if (isWebhookEvent(delivery, "organization.member.added")) {
      const { identity_id, role_id } = delivery.data.metadata;

      console.log(identity_id, role_id);
    }

    res.sendStatus(204);
  },
);
```

- Verify over the **raw bytes** received. Re-serializing parsed JSON changes spacing or key order and breaks the match; in Express, use `express.raw({ type: "application/json" })` on the webhook route.
- After a secret rotation the header briefly carries two signatures; either verifies. To roll the new secret out without a gap, pass both: `secret: [newSecret, oldSecret]`.
- A timestamp more than five minutes from the server's clock is refused as a replay (`toleranceSeconds` widens it).
- `applyEvent` drops only the subjects a change names (an assignment, a membership, an identity's status), everything for a role, permission, node or schema change, and nothing for a profile edit. It returns what it did.
- A delivery reaches one process. Across several instances either fan it out over your own pub/sub, or run `authorizer.replayChanges({ cursor })` on every instance on an interval shorter than `ttlMs`, keeping the cursor it returns. Run `replayChanges` at startup too, to catch up on what a process missed while down.
- Deliveries are at-least-once. `X-Canopy-Webhook-Id` is the same across retries: use it as an idempotency key for your own handlers. `applyEvent` is safe to repeat.
- Answer `2xx` quickly and do the work afterwards.
