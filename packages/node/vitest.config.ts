import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["src/**/*.ts"],
      // Generated types carry no logic to cover.
      exclude: ["src/generated/**", "src/index.ts"],
    },
  },
});
