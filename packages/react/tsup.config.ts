import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS like the other packages. The `"use client"` banner marks the
 * module for React Server Components frameworks: every export holds state or
 * runs effects, so it belongs on the client. Tree-shaking is left to the
 * app's bundler, because Rollup's pass here would drop the directive.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "browser",
  target: "es2020",
  banner: { js: '"use client";' },
  // React comes from the app; the browser client is this package's one
  // dependency and is installed beside it, never bundled into it.
  external: ["react", "@canopy-io/browser"],
});
