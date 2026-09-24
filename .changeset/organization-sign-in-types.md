---
"@canopy-io/node": patch
---

Type the organization sign-in surface: SSO connection, domains, recovery codes
and directory sync.

The API has let a backend configure an organization's own sign-in since
2026-09-18, and nothing in this package said so. A consumer checking the SDK —
or the coding agent working for them — found no such operations and concluded
Canopy could not do it. The published spec now carries 132 operations (was
102), all additive: no operation was removed or renamed, and no existing
request or response shape lost a field.

Newly typed, under `/api/v1/organizations/{id}`:

- **SSO connection** — create, read, update, remove, import SAML metadata,
  activate, disable, service-provider details, recent sign-ins.
- **Domains** — list, claim (returns the TXT challenge), verify, remove.
  Routing and just-in-time provisioning read only verified domains.
- **SSO recovery codes** — regenerate. Turning `require_sso` on through
  `updatePolicy` issues the first batch.
- **Test sign-in** — start, and read the outcome.
- **Directory sync** — create, read, remove; mint, rotate and revoke SCIM
  tokens; activity; groups and their role mappings; the roles a directory may
  grant.
- **Roles** — the roles assignable in the organization.

Plus Environment branding (read and update).

These are typed and callable today through `canopy.client.request` with
`RequestBody<…>` / `ResponseBody<…>`; resource methods for them are not in this
release. No caller changes are needed to take it.
