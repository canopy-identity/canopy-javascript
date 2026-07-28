/**
 * Generate `src/generated/types.ts` from Canopy's published OpenAPI document.
 *
 * The spec is fetched from a URL rather than vendored, because this repository
 * is separate from the API's. The alternatives — a git submodule or a job that
 * copies the file in — are both a second copy that can fall behind the first.
 * A URL has exactly one version of the truth, and it is the one customers get.
 *
 * The output IS committed. Three reasons: the repo builds without network
 * access, a reader can see the types without running anything, and a diff of
 * this file is a readable record of what changed in the API. The `--check`
 * mode is what keeps that honest — CI regenerates and fails if the committed
 * output no longer matches the live spec, so the SDK cannot silently describe
 * an API that has moved on.
 *
 *   npm run generate          write the file
 *   npm run generate:check    fail if the committed file is stale
 *
 * Override the source with CANOPY_SPEC_URL (a URL or a local path), which is
 * how you develop against an unreleased API.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SPEC = "https://canopy-io.com/openapi/api.json";
const OUTPUT = resolve(import.meta.dirname, "../src/generated/types.ts");

const source = process.env["CANOPY_SPEC_URL"] ?? DEFAULT_SPEC;
const checkOnly = process.argv.includes("--check");

/**
 * The banner names the canonical spec, never the source actually read.
 * Otherwise generating locally from a file and generating in CI from the URL
 * would produce different bytes, and `generate:check` would fail over the
 * provenance comment rather than over a real difference in the API.
 */
const BANNER = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`npm run generate\` from Canopy's published OpenAPI document.
 * Edit the API, not this file. \`npm run generate:check\` fails when this is
 * stale, so a hand edit will be reverted by the next run.
 *
 * Source: ${DEFAULT_SPEC}
 */

`;

function generate(): string {
  // openapi-typescript resolves $ref, allOf and nullable correctly, which is
  // the entire reason this is not a hand-rolled walk of the document.
  const out = execFileSync(
    "npx",
    ["openapi-typescript", source, "--empty-objects-unknown"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );

  return BANNER + out;
}

/**
 * "Could not reach the spec" and "the types are stale" are different answers
 * and deserve different exit codes.
 *
 * A contributor offline, or a CI run before the spec is published, should not
 * see a failure that reads like the API changed under them. Staleness is a
 * real problem; unreachability is a missing precondition. Conflating them
 * teaches people to ignore the check.
 */
function tryGenerate():
  | { ok: true; output: string }
  | { ok: false; reason: string } {
  try {
    return { ok: true, output: generate() };
  } catch (error) {
    return {
      ok: false,
      reason: (error as Error).message.split("\n")[0] ?? "unknown",
    };
  }
}

function readExisting(): string | null {
  try {
    return readFileSync(OUTPUT, "utf-8");
  } catch {
    return null;
  }
}

const attempt = tryGenerate();

if (!attempt.ok) {
  if (!checkOnly) {
    console.error(
      `✗ generate — could not read the spec at ${source}\n  ${attempt.reason}`,
    );
    process.exit(1);
  }

  // Skipped, loudly. Silence here would read as "the types are current".
  console.log(
    `⊘ generate:check — SKIPPED: could not reach ${source}\n` +
      `  ${attempt.reason}\n` +
      "  The committed types were NOT verified against the live spec.",
  );
  process.exit(0);
}

const generated = attempt.output;

if (!checkOnly) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, generated, "utf-8");

  const lines = generated.split("\n").length;

  console.log(
    `✓ generated src/generated/types.ts (${lines} lines) from ${source}`,
  );
  process.exit(0);
}

const existing = readExisting();

if (existing === null) {
  console.error(
    "✗ generate:check — src/generated/types.ts is missing. Run `npm run generate`.",
  );
  process.exit(1);
}

if (existing !== generated) {
  console.error(
    "✗ generate:check — src/generated/types.ts is stale: the published spec no " +
      "longer matches the committed types.\n\n" +
      "  Run `npm run generate` and commit the result. If the API changed in a " +
      "way that breaks callers, that belongs in a changeset.",
  );
  process.exit(1);
}

console.log(`✓ generate:check — committed types match ${source}`);
