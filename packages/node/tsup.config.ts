import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS, because an API client gets consumed by everything: modern
 * ESM services, CommonJS Node backends that still `require`, bundlers, and
 * edge runtimes. Shipping ESM-only would simply break the `require` case, and
 * for an SDK that is not a stylistic choice.
 *
 * `dts` emits one declaration file for both formats — the types are the real
 * product here, since they are what constrains a caller (or a caller's LLM)
 * to shapes the API actually accepts.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Node 18 is the floor: it is the first release where `fetch` is stable
  // without a flag, which is what lets this package have no dependencies.
  target: "node18",
  // Nothing to externalize — there are no runtime dependencies, and anything
  // that appeared in the bundle would be a mistake worth failing on.
  external: [],
});
