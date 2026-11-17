---
"@canopy-io/node": patch
---

Follows Canopy's release that makes a retried write safe across the public API's `POST` routes. The generated types add the `Idempotency-Key` header to every operation that honours it (33, up from a handful), with the `409`, `422` and `503` answers it brings. The agent skill says which writes honour the key, that a key names one request (body, `If-Match` and Environment), and that a key cannot retry its own rotation. No caller changes are needed.
