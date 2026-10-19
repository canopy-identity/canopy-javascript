import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Options } from "tsup";
import { describe, expect, it } from "vitest";

import tsupConfig from "../tsup.config.js";

/**
 * The shape a consumer installs, read from the manifest and the build config
 * rather than from a built tarball. `check:packaging` resolves the packed
 * output in CI; this pins the declarations that output is produced from.
 */

interface ConditionalExport {
  types: string;
  default: string;
}

interface Manifest {
  dependencies?: Record<string, string>;
  exports: Record<
    string,
    { import: ConditionalExport; require: ConditionalExport }
  >;
}

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
) as Manifest;

describe("the published package", () => {
  it("ships ESM and CommonJS, each with its own types", () => {
    const root = manifest.exports["."];
    const build = tsupConfig as Options;

    expect(root?.import).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(root?.require).toEqual({
      types: "./dist/index.d.cts",
      default: "./dist/index.cjs",
    });
    expect(build.format).toEqual(["esm", "cjs"]);
    expect(build.dts).toBe(true);
  });

  it("has no runtime dependencies", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
