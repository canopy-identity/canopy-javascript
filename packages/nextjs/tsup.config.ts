import { defineConfig } from "tsup";

/**
 * Two entries. The main one runs on the server only: the proxy, `auth()` and
 * the session helpers. `client` is the one module a client component imports,
 * marked `"use client"` for React Server Components; it holds no token and
 * makes no request.
 */
const shared = {
  format: ["esm", "cjs"] as ("esm" | "cjs")[],
  outExtension: ({ format }: { format: string }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
  dts: true,
  sourcemap: true,
  target: "es2022",
  // Next.js, React and the node SDK come from the app; none is bundled.
  external: ["next", "react", "@canopy-io/node"],
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    // Both builds write into dist at once, so neither cleans it; the build
    // script empties it first.
    clean: false,
    platform: "node",
  },
  {
    ...shared,
    entry: ["src/client.tsx"],
    clean: false,
    platform: "neutral",
    banner: { js: '"use client";' },
  },
]);
