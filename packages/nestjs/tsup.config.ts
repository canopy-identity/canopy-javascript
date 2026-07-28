import { defineConfig } from "tsup";

/**
 * Same dual ESM + CJS output as the client: a Nest application may be either,
 * and an integration that only ships one format simply fails to load in half
 * of them.
 *
 * Note that esbuild does not emit `design:paramtypes`, so nothing in this
 * package may rely on constructor type reflection for injection — every
 * injected dependency is named with an explicit `@Inject`.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "node18",
  external: [
    "@nestjs/common",
    "@nestjs/core",
    "@canopy-io/node",
    "reflect-metadata",
  ],
});
