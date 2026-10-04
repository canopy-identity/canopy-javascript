---
"@canopy-io/node": patch
---

Read and revoke an identity's sessions from your backend. `identities.sessions(id)` lists every live session the identity holds, newest first, with when and where it was signed in, when it expires and the organization it acts in, so you can confirm a sign-out from your own side. `identities.revokeSession(id, sessionId)` ends one of them and leaves the rest signed in, and `identities.revokeSessions(id)` ends them all. `IdentitySessionItem` types one session.

The generated types also pick up what the API added alongside: an SSO test sign-in result names the `missing_fields`, the `received_attributes`, the SAML `name_id_format` and a `hint` at the fix; a webhook subscription reports `previous_secret_expires_at` while a rotated-out secret still verifies; and the `organization.created` event carries `source: "self_signup"` when the Environment created the organization for a person who registered. No existing caller shape changed. The API's public operation count moves from 136 to 138.
