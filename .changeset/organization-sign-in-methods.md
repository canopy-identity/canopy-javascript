---
"@canopy-io/node": patch
---

Organization policy types regenerated from the live spec. `updatePolicy` accepts `allowed_sign_in_methods`, a non-empty subset of the methods the Environment offers (`password`, `email_otp`, `sso`) or `null` to inherit them all; a method the Environment has off is refused with `organization.policy_loosens`. `getPolicy` returns the field on the organization's own values, on `environment` (what is offered) and on `effective` (what members may use, `["sso"]` alone while `require_sso` is on).
