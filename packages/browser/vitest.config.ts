import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Node's global Web Crypto, fetch and Response are what the package uses
    // in a browser; storage and navigation are passed in by each test.
    environment: "node",
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
