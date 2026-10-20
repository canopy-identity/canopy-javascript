# Express, Fastify and other Node backends

There is no package for these frameworks. Build the guard from `TokenVerifier` and `LocalAuthorizer`, the same pieces `@canopy-io/nestjs` uses, and answer failures with `tokenErrorStatus` and `authorizationErrorStatus`, the mapping its guards use: a denial is `403`, an unreachable Canopy is `503`, a broken integration is `500`.

```ts
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  Canopy,
  LocalAuthorizer,
  TokenVerifier,
  authorizationErrorStatus,
  tokenErrorStatus,
  type CanopyTokenClaims,
} from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
const authorizer = new LocalAuthorizer(canopy.client);
const verifier = new TokenVerifier({
  environmentId: process.env.CANOPY_ENVIRONMENT_ID ?? "",
  // Hosted Login: your OAuth client id. Direct API: leave this out.
  audience: process.env.CANOPY_OAUTH_CLIENT_ID,
});

interface CanopyLocals {
  claims?: CanopyTokenClaims;
}

// 1. Authenticate: verify the bearer token, never decode it.
export async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;

  if (!token) {
    response.sendStatus(401);
    return;
  }

  try {
    // Identity tokens only, by default: admin and staff tokens are refused.
    (response.locals as CanopyLocals).claims = await verifier.verify(token);
    next();
  } catch (error) {
    // 401 when the token is at fault, 503 when the keys could not be read.
    response.sendStatus(tokenErrorStatus(error).status);
  }
}

// 2. Authorize: does the identity hold `permission` at the node `nodeOf` names?
export function requirePermission(
  permission: string,
  nodeOf: (request: Request) => unknown,
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const claims = (response.locals as CanopyLocals).claims;
    const nodeId = nodeOf(request);

    // No node, or not a single id: denied, never widened to app_wide.
    if (!claims || typeof nodeId !== "string" || nodeId === "") {
      response.sendStatus(403);
      return;
    }

    try {
      const { allowed } = await authorizer.evaluate({
        identity_id: claims.sub,
        permission,
        node_id: nodeId,
      });

      if (allowed) {
        next();
        return;
      }

      response.sendStatus(403);
    } catch (error) {
      // The mapping CanopyGuard uses. Never collapse these into one 403.
      response.sendStatus(authorizationErrorStatus(error).status);
    }
  };
}

const app = express();

app.get(
  "/nodes/:nodeId/reports",
  authenticate,
  requirePermission("reports.view", (request) => request.params["nodeId"]),
  (_request, response) => {
    response.json([]);
  },
);

export default app;
```

Notes:

- Create the verifier and the authorizer **once**, at module level. Per-request instances throw away the key-set and grant caches, which turns every request into network calls.
- The node comes from the route or from your own records (the node a document belongs to), never from a query string or header the caller sets freely.
- Fastify, Hono, Koa or a Next.js route handler: the same two steps. Verify the bearer token, then call `authorizer.evaluate`, mapping errors with `statusFor`.
- Webhook routes need the raw body for the signature check: see [node.md](node.md).
