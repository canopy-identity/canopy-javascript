---
"@canopy-io/node": patch
---

The generated types describe `passkey` as a sign-in method an organization's policy keeps or refuses. The agent skill now covers passkey sign-in on both sign-in shapes (the Direct API's `login/passkey/options` and `/verify` with the browser ceremony and autofill, the hosted page's button), the `hwk` `amr`, and the passkey refusals.
