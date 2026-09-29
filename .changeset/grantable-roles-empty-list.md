---
"@canopy-io/node": patch
---

`organizations.setDirectoryGrantableRoles` with an empty list now returns the organization to the Environment's list when one is set, under a connected directory too. It is refused only when there is no Environment list to fall back on. Types regenerated from the live spec; no signatures change.
