import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.tsx"],
    // The hooks render into a DOM; the browser client under them is a stand-in
    // each test drives, so no request leaves the test.
    environment: "jsdom",
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/index.ts"],
    },
  },
});
