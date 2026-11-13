---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

Document verifying tokens when a backend reaches Canopy at a different address than the one its tokens name: `issuer` as the token's `iss` reads, with `jwksUri` at the address the backend can reach, which must be a loopback address or a `*.localhost` name because Canopy refuses any other hostname.
