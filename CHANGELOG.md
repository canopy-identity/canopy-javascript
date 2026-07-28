# @canopy-io/sdk

## 0.1.0

### Minor Changes

- 8e2b399: Add the `Canopy` facade with `permissions`, `identities`, `roles` and `assignments` resources. Every request and response type is derived from the published OpenAPI document rather than hand-written.
- f1a510e: Add the client core: authentication, response-envelope unwrapping, typed errors, and a retry policy that will not repeat a non-idempotent request.
- 345dae8: Add `paginate` — one iterator that walks both offset and cursor pagination, inferring the style from the server's response.
- e21f27f: Add a spec-drift guard that fails when the API's operation surface changes, and relax `roles.list()` and `permissions.list()` to take no arguments now that the published spec no longer marks their filters required.
