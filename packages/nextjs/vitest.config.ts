import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The proxy and auth() run on Node.js, and every request to Canopy goes
    // through a fetch each test replaces, so nothing leaves the test.
    environment: "node",
  },
});
