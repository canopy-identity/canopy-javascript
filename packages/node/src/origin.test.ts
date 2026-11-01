import { afterEach, describe, expect, it } from "vitest";

import { hostedOrigin } from "./origin.js";

const ORIGINAL = process.env["CANOPY_BASE_URL"];

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env["CANOPY_BASE_URL"];
  } else {
    process.env["CANOPY_BASE_URL"] = ORIGINAL;
  }
});

describe("hostedOrigin", () => {
  it("is Canopy's hosted origin by default", () => {
    delete process.env["CANOPY_BASE_URL"];

    expect(hostedOrigin()).toBe("https://auth.canopy-io.com");
  });

  it("is CANOPY_BASE_URL when set, without trailing slashes", () => {
    process.env["CANOPY_BASE_URL"] = "http://localhost:3333/";

    expect(hostedOrigin()).toBe("http://localhost:3333");
  });

  it("ignores a blank CANOPY_BASE_URL", () => {
    process.env["CANOPY_BASE_URL"] = "   ";

    expect(hostedOrigin()).toBe("https://auth.canopy-io.com");
  });
});
