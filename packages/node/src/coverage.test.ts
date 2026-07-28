import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The drift guard between this package and the API.
 *
 * TypeScript already catches an operation being *renamed* — `RequestBody<"X">`
 * stops resolving. What it cannot see is an operation being *added*: the SDK
 * keeps compiling, and the new endpoint is simply missing with nobody
 * noticing. That is the failure this file exists for.
 *
 * The ledger below is deliberately a single number rather than a list of every
 * unwrapped operation. A 56-line allowlist would be noise nobody reads, and the
 * signal wanted here is "the API's surface changed — decide what to do about
 * it", which one count delivers just as well.
 */

const SRC = resolve(import.meta.dirname);

/**
 * Operations in the published spec, as of the committed types. Bump this
 * deliberately when the API's surface changes, and say why in the changeset.
 */
const EXPECTED_OPERATION_COUNT = 81;

/**
 * Operations reachable through a typed resource method. Only ever goes up;
 * a drop means a wrapper was removed, which should be a conscious decision.
 */
const COVERAGE_FLOOR = 25;

function generatedOperationIds(): string[] {
  const source = readFileSync(join(SRC, "generated/types.ts"), "utf-8");
  const body = source.slice(source.indexOf("export interface operations {"));
  const ids = [...body.matchAll(/^\s{4}([A-Za-z0-9_]+):\s*\{/gm)].map(
    (match) => match[1] as string,
  );

  return [...new Set(ids)];
}

/**
 * Operation ids the hand-written resources name, read out of the source rather
 * than a registry — every method types itself through `RequestBody<"…">` or
 * `ResponseBody<"…">`, so the source is the registry.
 */
function referencedOperationIds(): string[] {
  const dir = join(SRC, "resources");
  const ids = new Set<string>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
      continue;
    }

    const source = readFileSync(join(dir, file), "utf-8");

    for (const match of source.matchAll(
      /(?:RequestBody|ResponseBody|QueryParams)<"([A-Za-z0-9_]+)">/g,
    )) {
      ids.add(match[1] as string);
    }
  }

  return [...ids];
}

describe("spec coverage", () => {
  const all = generatedOperationIds();
  const referenced = referencedOperationIds();

  it("reads the generated operations", () => {
    // Guards the parser: an empty list would make the assertions below vacuous.
    expect(all.length).toBeGreaterThan(60);
  });

  /**
   * Fails when the API gains or loses an operation. That is the whole point —
   * a new endpoint should be a decision (wrap it, or note that it is not
   * wrapped yet), not something that lands silently.
   */
  it("matches the operation count the SDK was built against", () => {
    expect(all.length).toBe(EXPECTED_OPERATION_COUNT);
  });

  /**
   * A resource naming an operation that no longer exists would be caught by
   * `tsc` too, but the message here says which one and why it matters.
   */
  it("references only operations that exist in the spec", () => {
    const unknown = referenced.filter((id) => !all.includes(id));

    expect(unknown).toEqual([]);
  });

  it("has not lost wrapper coverage", () => {
    expect(referenced.length).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
  });

  /**
   * Not an assertion so much as a printed fact: the wrapped surface is
   * deliberately partial, and `canopy.client.request` reaches the rest. Worth
   * seeing in test output so "how much is wrapped?" never needs guessing.
   */
  it("reports how much of the API has a typed wrapper", () => {
    const percent = Math.round((referenced.length / all.length) * 100);

    console.log(
      `  spec coverage: ${referenced.length}/${all.length} operations wrapped (${percent}%) — the rest are reachable via client.request`,
    );

    expect(percent).toBeGreaterThan(0);
  });
});
