import { describe, expect, it } from "vitest";

import {
  CanopyAuthorizerError,
  CanopyError,
  CanopyTokenError,
} from "./errors.js";
import { authorizationErrorStatus, tokenErrorStatus } from "./status.js";

function canopyError(statusCode: number, code: string | null = null) {
  return new CanopyError(
    {
      statusCode,
      code,
      message: `canopy said ${statusCode}`,
      path: "/api/v1/identities/x/grants",
    },
    { method: "GET", path: "/api/v1/identities/x/grants" },
  );
}

describe("tokenErrorStatus", () => {
  it("answers 503 when the signing keys could not be read", () => {
    expect(
      tokenErrorStatus(new CanopyTokenError("token.jwks_unavailable", "down"))
        .status,
    ).toBe(503);
  });

  it("answers 401 for every fault in the token itself", () => {
    for (const code of [
      "token.expired",
      "token.signature_invalid",
      "token.type_not_allowed",
      "token.key_not_found",
    ]) {
      expect(tokenErrorStatus(new CanopyTokenError(code, "bad")).status).toBe(
        401,
      );
    }
  });

  it("answers 500 for something that is not a token error", () => {
    expect(tokenErrorStatus(new Error("bug")).status).toBe(500);
  });
});

describe("authorizationErrorStatus", () => {
  it("answers 503 when Canopy never answered", () => {
    expect(authorizationErrorStatus(new TypeError("fetch failed")).status).toBe(
      503,
    );
  });

  it("answers 500 for an authorizer that cannot see far enough to decide", () => {
    expect(
      authorizationErrorStatus(
        new CanopyAuthorizerError("authorizer.tree_unreadable", "no tree"),
      ).status,
    ).toBe(500);
  });

  it("answers 500 when Canopy rejects our own credential", () => {
    expect(authorizationErrorStatus(canopyError(401)).status).toBe(500);
    expect(authorizationErrorStatus(canopyError(403)).status).toBe(500);
  });

  it("answers 500 for an endpoint this Canopy does not serve, and 403 for an identity it does not know", () => {
    expect(authorizationErrorStatus(canopyError(404)).status).toBe(500);
    expect(
      authorizationErrorStatus(canopyError(404, "identity.not_found")).status,
    ).toBe(403);
  });

  /**
   * A read Canopy refused as malformed, such as a page size above the 100 it
   * serves, is a bug in the reader that no retry fixes, not an outage.
   */
  it("answers 500 when Canopy refuses the read as malformed", () => {
    expect(authorizationErrorStatus(canopyError(400)).status).toBe(500);
  });

  it("answers 503 when Canopy is rate limiting or failing", () => {
    expect(authorizationErrorStatus(canopyError(429)).status).toBe(503);
    expect(authorizationErrorStatus(canopyError(502)).status).toBe(503);
  });
});
