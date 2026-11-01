---
"@canopy-io/nestjs": patch
---

The README registers `CanopyModule` with `isGlobal: true` and says why: guarded controllers usually live in feature modules, and without it their guards cannot resolve the token verifier and the application refuses to start. No code change; the option has always existed and still defaults to `false`.
