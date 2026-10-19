import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { operations, paths } from "./generated/types.js";

/**
 * Guards the generation itself, which is otherwise the one part of this package
 * nobody writes and therefore nobody reviews.
 *
 * The failure this catches is generation producing something syntactically
 * valid but empty — an unreachable spec that yields a stub, a flag change that
 * drops `operations`. `tsc` would still pass on an empty interface, and so
 * would every later test that only uses a handful of types.
 */

const GENERATED = resolve(import.meta.dirname, "generated/types.ts");

describe("generated types", () => {
  const source = readFileSync(GENERATED, "utf-8");

  it("declares the three top-level surfaces the client builds on", () => {
    expect(source).toContain("export interface paths");
    expect(source).toContain("export interface operations");
    expect(source).toContain("export interface components");
  });

  it("carries the whole public API, not a stub", () => {
    // 81 operations at the time of writing. The floor is deliberately well
    // below that: this asserts "a real spec was read", not an exact count that
    // would fail on every endpoint added.
    const operationCount = (source.match(/operations\["/g) ?? []).length;

    expect(operationCount).toBeGreaterThan(60);
  });

  it("is marked generated, so nobody edits it by hand", () => {
    expect(source).toContain("GENERATED FILE — do not edit");
  });
});

/**
 * Freshness is enforced by `generate:check`, which regenerates from the
 * published spec and fails when the committed file differs. These assert it
 * stays wired into the gates: CI on every push and PR, `verify`, which the
 * release job runs before it publishes, and the weekly drift job. A run that
 * cannot reach the spec skips rather than fails, by design.
 */
describe("keeping the generated types current", () => {
  const REPO = resolve(import.meta.dirname, "../../..");

  const read = (path: string): string =>
    readFileSync(resolve(REPO, path), "utf-8");

  const scripts = (path: string): Record<string, string> =>
    (JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts;

  it("checks the types against the published spec on every pull request, before every release and weekly", () => {
    const source = readFileSync(GENERATED, "utf-8");

    expect(source).toContain("Source: https://canopy-io.com/openapi/api.json");
    expect(scripts("packages/node/package.json")["generate:check"]).toBe(
      "tsx scripts/generate-types.ts --check",
    );
    expect(read(".github/workflows/ci.yml")).toContain(
      "- run: npm run generate:check",
    );
    expect(scripts("package.json")["verify"]).toContain(
      "npm run generate:check",
    );
    expect(read(".github/workflows/release.yml")).toContain(
      "- run: npm run verify",
    );
    expect(read(".github/workflows/spec-drift.yml")).toContain(
      "npm run --silent generate:check",
    );
    expect(read(".github/workflows/spec-drift.yml")).toMatch(/schedule:/);
  });
});

/**
 * Compile-time assertions. These cost nothing at runtime and fail under `tsc`
 * if the named operation stops existing — which is what would happen if the
 * API renamed it, and exactly what a caller needs to hear about at build time
 * rather than in production.
 */
describe("the operations the client will wrap exist in the spec", () => {
  it("types the permission evaluation path", () => {
    type Evaluate = operations["ApiPermissionsController_evaluate"];
    type EvaluatePath = paths["/api/v1/permissions/evaluate"]["post"];

    // Referencing the types is the assertion; this keeps them used at runtime
    // so the test reports rather than being elided.
    const named: [keyof Evaluate, unknown] = ["responses", null];

    expect(named[0]).toBe("responses");
    expect<EvaluatePath extends never ? false : true>(true).toBe(true);
  });
});
