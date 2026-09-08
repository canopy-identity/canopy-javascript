---
"@canopy-io/node": patch
---

Regenerate the request/response types from Canopy's OpenAPI document.
Additive, no existing caller shape changed:

- MFA factor entries carry `webauthn_rp_id`: for a passkey, the relying-party
  id it was created under and the only domain it answers on (the
  Environment's own `webauthn_rp_id`, or Canopy's when the Environment names
  none). `null` for every other factor type.
