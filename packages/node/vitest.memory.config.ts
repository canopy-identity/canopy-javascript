import { defineConfig } from "vitest/config";

/**
 * The memory measurements, run apart from the unit tests: they need a heap
 * that can be settled on demand (`--expose-gc`) and nothing else running in
 * the same worker.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.memory.test.ts"],
    environment: "node",
    pool: "forks",
    execArgv: ["--expose-gc"],
    fileParallelism: false,
  },
});
