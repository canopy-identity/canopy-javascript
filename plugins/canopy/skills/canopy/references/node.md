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
- With organizations on, read the organization through `orgContext(claims)`, which returns `{ orgId, orgRoles, orgRoleIds }` or `null`, rather than off the raw claims. `orgRoles` is empty for a member holding no role at the organization node; authorize by evaluating, not by the list.

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

- A client's grants are read from `GET /api/v1/oauth-clients/:id/grants` and cached apart from people's. Invalidate one with `authorizer.invalidate(clientId, { principalType: "service" })`, where `clientId` is the `client_id` an assignment webhook carries in `data.metadata.client_id`.
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
- A denial carries `reason` (`permission_not_held`, `outside_grants`, `expired`, `not_yet_effective`, `node_missing`). `onDecision` / `onDenied` options hear every verdict after it is reached; they are never awaited and cannot change it.
- To filter a list, do not call `evaluate` per row. `authorizer.accessibleNodes(identityId, permission)` gives the node ids the identity may see as a `Set` for an `IN (...)` filter (`nodes: null, complete: false` past `maxNodes`; `envWide: true` means no filter at all), and `authorizer.grantRoots(...)` gives the roots for a closure-table or path filter. `authorizer.permissionsAt(identityId, nodeId)` lists what someone holds at one node, and `permissionsAtMany(identityId, nodeIds)` several nodes from one read. All three answer from the same cache as a check. The write that follows still checks its node.
- Answers are cached for at most 60 seconds (`ttlMs`, up to 300 000). That is the revocation delay. Use `canopy.permissions.evaluate` for a decision that must be fresh.
- A scoped API key needs `identity.view` and `hierarchy.view`. Without `hierarchy.view`, node checks throw `CanopyAuthorizerError` instead of answering `false`: treat that as a broken integration (`500`), not a denial.
- Mapping failures to HTTP statuses: see [express.md](express.md).

## Webhooks

The SDK types deliveries (`isWebhookEvent` narrows by event name) but does not check signatures. Check every delivery before acting on it: an HMAC-SHA256 with the subscription's signing secret over `{X-Canopy-Webhook-Id}.{X-Canopy-Timestamp}.{raw body}`, sent in `X-Canopy-Signature` as `v1,<hex>`. After a secret rotation the header briefly carries two values separated by a space, the new secret's first.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { isWebhookEvent, type WebhookDelivery } from "@canopy-io/node";

export function verifyCanopySignature(
  headers: Record<string, string | undefined>,
  rawBody: string,
  secret: string,
): boolean {
  const id = headers["x-canopy-webhook-id"];
  const timestamp = headers["x-canopy-timestamp"];
  const signature = headers["x-canopy-signature"];

  if (!id || !timestamp || !signature) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  // Compare each value on its own, in constant time.
  return signature
    .split(/\s+/)
    .filter((value) => value.startsWith("v1,"))
    .map((value) => Buffer.from(value.slice("v1,".length), "hex"))
    .some(
      (actual) =>
        actual.length === expected.length && timingSafeEqual(actual, expected),
    );
}

export function handleDelivery(rawBody: string): void {
  const delivery = JSON.parse(rawBody) as WebhookDelivery;

  if (isWebhookEvent(delivery, "organization.member.added")) {
    const { identity_id, role_id } = delivery.data.metadata;

    console.log(identity_id, role_id);
  }
}
```

- Sign over the **raw bytes** received. Re-serializing parsed JSON changes spacing or key order and breaks the match; in Express, use `express.raw({ type: "application/json" })` on the webhook route.
- Deliveries are at-least-once. `X-Canopy-Webhook-Id` is the same across retries: use it as an idempotency key.
- Answer `2xx` quickly and do the work afterwards.
