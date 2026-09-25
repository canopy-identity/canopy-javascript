---
"@canopy-io/node": patch
---

Set up an organization's directory sync (SCIM) from your backend.

- `organizations.setDirectoryGrantableRoles` and `listDirectoryGrantableRoles` wrap the two new operations, `PUT`/`GET /api/v1/organizations/{id}/directory/grantable-roles`. Naming the roles an organization's identity provider may grant, and the one people arrive with, is what opens directory sync for it. Only your API key can set the list; an organization admin's token can read it and is refused changing it.
- The rest of an organization's directory is wrapped too: `getDirectory`, `createDirectory`, `removeDirectory`, `listDirectoryTokens`, `mintDirectoryToken`, `rotateDirectoryToken`, `revokeDirectoryToken`, `listDirectoryActivity`, `listDirectoryGroups`, `mapDirectoryGroup` and `unmapDirectoryGroup`. They were already typed and reachable through `client.request`.
- `base_url` on a directory and on a minted token is now the full URL, including the host, so it can be handed to a customer as it is. If you were putting your API host in front of it, stop.

The published spec gained 2 operations (132 to 134), both additive, so this is a patch.
