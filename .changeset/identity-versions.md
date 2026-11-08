---
"@canopy-io/node": patch
---

`identities.update` takes `{ ifMatch }`, so a save over someone else's newer change answers 409 instead of overwriting it. The generated types add `version` to identities, API keys, publishable keys, SCIM groups and the access model, `binding_version` to an organization's SSO connection, and the `If-Match` header on the routes that compare them. Nothing existing changes shape: a call that sends no version behaves as before.
