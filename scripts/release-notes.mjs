#!/usr/bin/env node
/**
 * Print one version's section of a package's CHANGELOG, for a GitHub Release.
 *
 * Changesets already writes the changelog and cuts a tag per published version,
 * but it creates no release, and `files` used to omit the changelog from the
 * tarball. The net effect was that we wrote release notes on every PR and a
 * consumer could see none of them: npm showed no changelog, and the Releases
 * page was empty next to a list of tags. Runtime Forge, our first external
 * consumer, took the 0.3.1 → 0.3.2 bump with nothing to read.
 *
 * The changelog is the source. Nothing here generates prose, so the notes on a
 * release are exactly the notes in the file, and a release cannot describe a
 * version differently from the package that shipped it.
 *
 * Usage:
 *   node scripts/release-notes.mjs packages/node 0.3.2
 *
 * Exits non-zero when that version has no section, which means the tag and the
 * changelog disagree and the release should not be created blind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [packageDir, version] = process.argv.slice(2);

if (!packageDir || !version) {
  console.error("usage: release-notes.mjs <package-dir> <version>");
  process.exit(1);
}

const changelog = readFileSync(join(packageDir, "CHANGELOG.md"), "utf8");

// Sections are `## <version>` and run until the next `## ` at the same level.
// Matching on the heading rather than splitting on a blank line keeps a
// multi-paragraph entry, including its nested bullet lists, intact.
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.trim() === `## ${version}`);

if (start === -1) {
  console.error(
    `${packageDir}/CHANGELOG.md has no section for ${version}. ` +
      "The tag and the changelog disagree.",
  );
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## "));
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

if (body.length === 0) {
  console.error(`${packageDir}/CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}

console.log(body);
