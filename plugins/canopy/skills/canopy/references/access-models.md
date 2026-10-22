# Access models

Every Canopy Environment has a hierarchy of nodes. Roles are assigned to an identity **at a node**, and a grant at a node covers that node and everything beneath it. What changes between models is what the hierarchy looks like, and so which node a check names. Ask the user which model their Environment uses, or look in the Console.

## Flat

Every Environment starts flat: a single root node, and every assignment lands on it.

- Check with `scope: "app_wide"`: "does the identity hold this permission in the Environment". No node is needed.
- Or check with the default `node` scope at the root node's id. Read it once from `GET /api/v1/nodes`, a paged `{ items, pagination }` list of flat nodes: the root is the one whose `parent_node_id` is `null`, and in a flat Environment it is the only item. Never send a `node` check without a node: it is denied.
- If the Environment may later become a hierarchy, prefer the `node` form at the resource's node now, falling back to the root: the code then keeps working when nodes appear.

## Hierarchy

Nodes model the customer's structure (regions, departments, sites). Each resource in the application belongs to a node, and the check names **that** node.

- Store the node id on the application's own records (a document's `node_id`) and authorize against it.
- A role granted at a parent is inherited below it; there is nothing to model.
- A missing node is a denial, never a fallback to `app_wide`.
- Moving a node changes what inherited grants reach. The SDK revalidates the hierarchy on the same cadence as grants (60 seconds by default).
- A list of resources is filtered by the nodes the identity may see, not by a check per row: `authorizer.accessibleNodes(identityId, permission)` for `WHERE node_id IN (...)`, or `authorizer.grantRoots(...)` against a closure table or materialised path when the tree is large. An `envWide` answer needs no filter.

## Organizations

An optional container, on top of either model, for B2B tenancy: each customer is an organization, which is also a node. Membership is admission, a record of its own; a member's roles are assignments at the organization's node or beneath it, and may be none.

- Identity tokens carry `org_id` (the organization the session is acting in) and `org_roles` (the roles held at its node, possibly empty). Read them with `orgContext(claims)`.
- Authorize at the organization's node: `node_id` is the token's `org_id`. In NestJS, `@RequirePermission("invoices.view", { scope: "org" })` does this.
- Take the organization from the **verified token**, and refuse records that belong to another organization. A caller acting in no organization is denied on an organization-scoped route.
- A grant at the root (an internal administrator) reaches every organization.

```ts
import {
  Canopy,
  LocalAuthorizer,
  orgContext,
  type CanopyTokenClaims,
} from "@canopy-io/node";

const canopy = new Canopy({ apiKey: process.env.CANOPY_API_KEY });
const authorizer = new LocalAuthorizer(canopy.client);

interface Invoice {
  id: string;
  org_id: string;
}

export async function mayViewInvoice(
  claims: CanopyTokenClaims,
  invoice: Invoice,
): Promise<boolean> {
  const org = orgContext(claims);

  // No organization on the session, or the invoice belongs to another tenant.
  if (!org || invoice.org_id !== org.orgId) {
    return false;
  }

  const { allowed } = await authorizer.evaluate({
    identity_id: claims.sub,
    permission: "invoices.view",
    node_id: org.orgId,
  });

  return allowed;
}
```
