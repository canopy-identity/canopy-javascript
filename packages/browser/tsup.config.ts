import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS like the other packages: a bundler picks whichever it
 * prefers, and the ESM build also loads straight from a `<script
 * type="module">` with no bundler at all.
 *
 * ES2020 is the floor because every browser that runs the Web Crypto
 * `subtle.digest` this package needs for PKCE already runs it.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  platform: "browser",
  target: "es2020",
  // No runtime dependencies: anything that appeared in the bundle would be a
  // mistake worth failing on.
  external: [],
});
