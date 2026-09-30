---
"@canopy-io/node": patch
---

Webhook types regenerated from the live spec. Deliveries for a change directory sync made (`identity.created`, `identity.env_membership.*`, `organization.member.*`, `assignment.bulk_*`) now type `source: "scim"` and `directory_id`, and the directory's own activity is subscribable: `scim.user.provisioned` / `updated` / `deprovisioned` / `reactivated`, `scim.group.created` / `updated` / `deleted` / `member_added` / `member_removed` / `mapped` / `unmapped`. `identity.created` also types `source: "sso_jit"` with `connection_id` for an identity a first SSO sign-in created.
