---
"@canopy-io/node": patch
---

Types regenerated from the spec, with no shape change: the descriptions now say that a deactivated role grants nothing to its holders (`is_active`, the explain trace's `active`), and that an empty `allowed_children` list makes a node type a leaf.

`Authorizer.invalidate()` documents deactivating or reactivating a role as a change to clear the whole cache for, since it changes access for everyone holding the role at once.

The identity invite create and resend descriptions say a `password_reset` invite expires after 24 hours; every other invite still expires after 7 days.
