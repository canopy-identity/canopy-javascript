---
"@canopy-io/node": minor
---

SSO connection responses no longer carry `last_login_failure_at`, `consecutive_failures` or `auto_disabled_at`. Nothing ever set them, so they only ever returned their defaults; a connection is disabled only by a person. `last_login_at` stays and now records each successful sign-in through the connection.
