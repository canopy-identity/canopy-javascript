import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import { VERSION } from "@angular/compiler-cli";
import linkerPlugin from "@angular/compiler-cli/linker/babel";
import { describe, expect, it } from "vitest";

/**
 * The published build is partially compiled; an app's own Angular links it
 * when the app builds. The lowest Angular the package supports must link it,
 * so the build is linked here with the Angular these tests install, which is
 * that lowest version. `npm run build` writes the bundle first.
 */
const BUNDLE = fileURLToPath(
  new URL("../dist/fesm2022/canopy-io-angular.mjs", import.meta.url),
);

describe("the published build", () => {
  it("is linked by the lowest Angular the package supports", async () => {
    expect(VERSION.major).toBe("20");

    const source = readFileSync(BUNDLE, "utf8");
    const linked = await transformAsync(source, {
      filename: BUNDLE,
      babelrc: false,
      configFile: false,
      compact: false,
      plugins: [linkerPlugin],
    });

    expect(linked?.code).toBeTruthy();
    expect(linked?.code).not.toContain("ɵɵngDeclare");
  });
});
