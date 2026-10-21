/**
 * Generate `src/generated/types.ts` from Canopy's published OpenAPI document,
 * and `src/generated/conformance.json` from its published authorization
 * conformance vectors.
 *
 * Both are fetched from a URL rather than vendored, because this repository
 * is separate from the API's. The alternatives — a git submodule or a job that
 * copies the file in — are both a second copy that can fall behind the first.
 * A URL has exactly one version of the truth, and it is the one customers get.
 *
 * The output IS committed. Three reasons: the repo builds without network
 * access, a reader can see the types without running anything, and a diff of
 * these files is a readable record of what changed in the API. The `--check`
 * mode is what keeps that honest — CI regenerates and fails if the committed
 * output no longer matches what is published, so the SDK cannot silently
 * describe an API that has moved on, or pass vectors the API no longer holds.
 *
 *   npm run generate          write the files
 *   npm run generate:check    fail if a committed file is stale
 *
 * Override the sources with CANOPY_SPEC_URL and CANOPY_CONFORMANCE_URL (a URL
 * or a local path), which is how you develop against an unreleased API.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SPEC = "https://canopy-io.com/openapi/api.json";
const DEFAULT_CONFORMANCE =
  "https://canopy-io.com/conformance/authorization.json";

const checkOnly = process.argv.includes("--check");

/** One file this script keeps in step with something Canopy publishes. */
interface Artifact {
  /** Repository-relative, for messages. */
  name: string;
  output: string;
  source: string;
  produce: () => string | Promise<string>;
  /** What to do when it is stale, beyond regenerating. */
  staleAdvice: string;
}

const specSource = process.env["CANOPY_SPEC_URL"] ?? DEFAULT_SPEC;
const conformanceSource =
  process.env["CANOPY_CONFORMANCE_URL"] ?? DEFAULT_CONFORMANCE;

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

function generateTypes(): string {
  // openapi-typescript resolves $ref, allOf and nullable correctly, which is
  // the entire reason this is not a hand-rolled walk of the document.
  const out = execFileSync(
    "npx",
    ["openapi-typescript", specSource, "--empty-objects-unknown"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );

  return BANNER + out;
}

/**
 * The vectors, re-serialized so the committed bytes do not depend on how the
 * source happened to format them: the published copy is compact, a local one
 * is not, and the content is what has to match.
 */
async function generateConformance(): Promise<string> {
  const raw = /^https?:\/\//.test(conformanceSource)
    ? await (async () => {
        const response = await fetch(conformanceSource);

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        return response.text();
      })()
    : readFileSync(conformanceSource, "utf-8");

  return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
}

const ARTIFACTS: Artifact[] = [
  {
    name: "src/generated/types.ts",
    output: resolve(import.meta.dirname, "../src/generated/types.ts"),
    source: specSource,
    produce: generateTypes,
    staleAdvice:
      "If the API changed in a way that breaks callers, that belongs in a changeset.",
  },
  {
    name: "src/generated/conformance.json",
    output: resolve(import.meta.dirname, "../src/generated/conformance.json"),
    source: conformanceSource,
    produce: generateConformance,
    staleAdvice:
      "Canopy changed an authorization rule: run the suite, and make `LocalAuthorizer` answer the new vectors before releasing.",
  },
];

/**
 * "Could not reach the source" and "the file is stale" are different answers
 * and deserve different exit codes.
 *
 * A contributor offline, or a CI run before the API is published, should not
 * see a failure that reads like the API changed under them. Staleness is a
 * real problem; unreachability is a missing precondition. Conflating them
 * teaches people to ignore the check.
 */
async function tryProduce(
  artifact: Artifact,
): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
  try {
    return { ok: true, output: await artifact.produce() };
  } catch (error) {
    return {
      ok: false,
      reason: (error as Error).message.split("\n")[0] ?? "unknown",
    };
  }
}

function readExisting(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

let failed = false;

for (const artifact of ARTIFACTS) {
  const attempt = await tryProduce(artifact);

  if (!attempt.ok) {
    if (!checkOnly) {
      console.error(
        `✗ generate — could not read ${artifact.source}\n  ${attempt.reason}`,
      );
      process.exit(1);
    }

    // Skipped, loudly. Silence here would read as "the file is current".
    console.log(
      `⊘ generate:check — SKIPPED: could not reach ${artifact.source}\n` +
        `  ${attempt.reason}\n` +
        `  The committed ${artifact.name} was NOT verified against it.`,
    );
    continue;
  }

  const generated = attempt.output;

  if (!checkOnly) {
    mkdirSync(dirname(artifact.output), { recursive: true });
    writeFileSync(artifact.output, generated, "utf-8");

    const lines = generated.split("\n").length;

    console.log(
      `✓ generated ${artifact.name} (${lines} lines) from ${artifact.source}`,
    );
    continue;
  }

  const existing = readExisting(artifact.output);

  if (existing === null) {
    console.error(
      `✗ generate:check — ${artifact.name} is missing. Run \`npm run generate\`.`,
    );
    failed = true;
    continue;
  }

  if (existing !== generated) {
    console.error(
      `✗ generate:check — ${artifact.name} is stale: what Canopy publishes ` +
        "no longer matches the committed file.\n\n" +
        `  Run \`npm run generate\` and commit the result. ${artifact.staleAdvice}`,
    );
    failed = true;
    continue;
  }

  console.log(
    `✓ generate:check — committed ${artifact.name} matches ${artifact.source}`,
  );
}

process.exit(failed ? 1 : 0);
