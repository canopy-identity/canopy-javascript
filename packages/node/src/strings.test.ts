import { describe, expect, it } from "vitest";

import { withoutTrailingSlashes } from "./strings.js";

describe("withoutTrailingSlashes", () => {
  it.each([
    ["https://auth.acme.com", "https://auth.acme.com"],
    ["https://auth.acme.com/", "https://auth.acme.com"],
    ["https://auth.acme.com///", "https://auth.acme.com"],
    ["/", ""],
    ["", ""],
  ])("%s becomes %s", (input, expected) => {
    expect(withoutTrailingSlashes(input)).toBe(expected);
  });

  it("stays linear on a long run of slashes that does not end the string", () => {
    const input = `${"/".repeat(100_000)}x`;
    const started = performance.now();

    expect(withoutTrailingSlashes(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
