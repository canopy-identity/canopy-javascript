---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

Fix type resolution for CommonJS consumers on `node16`/`nodenext`: the
`exports` map now declares per-condition `types`, pointing `require` at the
`index.d.cts` the build already emitted. Previously a `require()` that worked
at runtime was rejected by TypeScript (TS1479), forcing dynamic-import and
`resolution-mode` workarounds. Verified with `arethetypeswrong` across
node10, node16-CJS, node16-ESM and bundler resolution.
