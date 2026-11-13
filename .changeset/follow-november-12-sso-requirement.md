---
"@canopy-io/node": patch
---

Follows Canopy's November 12 release. The generated types add `require_sso_ready` to an organization's policy, which says whether `require_sso` can be turned on (an active SSO connection bound to the organization and a verified domain), and `conferred_capabilities` to administrator roles. Turning `require_sso` on before then, or removing an organization's last verified domain or disabling, unbinding or deleting its last active connection while it is on, answers `409`. An identity's session list now names a hosted sign-in no application has exchanged a code for yet by its session id, and `identities.revokeSession` ends it. No caller changes are needed.
