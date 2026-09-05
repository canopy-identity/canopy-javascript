---
"@canopy-io/node": minor
"@canopy-io/nestjs": patch
---

Organizations as a container: `canopy.organizations` wraps the tenant API
(organizations, members, invitations, the per-organization sign-in policy,
and SSO connection binding), `CanopyTokenClaims` declares `amr`, types are
regenerated against the current spec, and the wording no longer describes
organizations as an access model. The published spec now carries 102 operations (was 84), all additive.
