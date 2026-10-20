---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

The NestJS README's first `CanopyModule.forRoot` example now includes the required `verify` option, and `@canopy-io/node`'s types are regenerated from the published spec, adding the `branding.view` and `branding.manage` API key scopes. No behaviour changes.
