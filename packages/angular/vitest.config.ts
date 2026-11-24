import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: ["src/server.test.ts", "src/linker.test.ts"],
          // TestBed compiles the directives just in time, into a DOM; the
          // browser client under them is a stand-in each test drives.
          environment: "jsdom",
          setupFiles: ["src/testing/setup.ts"],
        },
      },
      {
        test: {
          name: "server",
          // Rendered on Angular's server platform in plain Node, so it
          // loads none of the browser test setup; the build is linked there
          // too.
          include: ["src/server.test.ts", "src/linker.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
