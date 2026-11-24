---
"@canopy-io/browser": minor
---

`listOrganizations()` and `getOrganizationsState()`: the organizations the signed-in person belongs to, by name, for an organization switcher. Read once and held like a permission answer, until the token is refreshed, the organization changes or the person signs out; a failure is held for 30 seconds or its `Retry-After`.
