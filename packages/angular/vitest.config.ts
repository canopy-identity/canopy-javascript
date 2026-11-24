import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // TestBed compiles the directives just in time, into a DOM; the browser
    // client under them is a stand-in each test drives.
    environment: "jsdom",
    setupFiles: ["src/testing/setup.ts"],
  },
});
