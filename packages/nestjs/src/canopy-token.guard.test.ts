import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  CanopyTokenError,
  type CanopyTokenClaims,
  type TokenVerifier,
} from "@canopy-io/node";

import { CanopyTokenGuard } from "./canopy-token.guard.js";
import type { CanopyModuleOptions } from "./options.js";

/**
 * The question behind every test here: can a request reach the handler
 * carrying claims nothing verified?
 *
 * `CanopyGuard` reads whatever this attaches, so a guard that attaches
 * unverified claims does not merely fail to authenticate — it hands the
 * authorization guard a subject of the caller's choosing.
 */

const CLAIMS = {
  sub: "idn_123",
  type: "identity",
  iss: "https://auth.canopy-io.com",
  exp: 9_999_999_999,
} as unknown as CanopyTokenClaims;

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function setup(
  verify: () => Promise<CanopyTokenClaims>,
  options: Partial<CanopyModuleOptions<unknown>> = {},
) {
  const verifyMock = vi.fn(verify);
  const verifier = { verify: verifyMock } as unknown as TokenVerifier;

  const guard = new CanopyTokenGuard(verifier, {
    resolveIdentity: () => undefined,
    ...options,
  } satisfies CanopyModuleOptions<unknown>);

  return { guard, verifyMock };
}

describe("CanopyTokenGuard — a verified token", () => {
  it("attaches the claims and lets the request through", async () => {
    const { guard } = setup(() => Promise.resolve(CLAIMS));
    const request: FakeRequest = { headers: { authorization: "Bearer good" } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request["canopyToken"]).toEqual(CLAIMS);
  });

  it("passes the raw token to the verifier, without the scheme", async () => {
    const { guard, verifyMock } = setup(() => Promise.resolve(CLAIMS));

    await guard.canActivate(
      contextFor({ headers: { authorization: "Bearer abc.def.ghi" } }),
    );

    expect(verifyMock).toHaveBeenCalledWith("abc.def.ghi");
  });

  it("accepts a lowercase scheme, which clients do send", async () => {
    const { guard } = setup(() => Promise.resolve(CLAIMS));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "bearer t" } })),
    ).resolves.toBe(true);
  });

  /**
   * `user` belongs to Passport. An app that already populates it would be very
   * surprised to find it replaced, so the default lands elsewhere and the
   * property is configurable for anyone who wants otherwise.
   */
  it("attaches where told, so it cannot collide with request.user", async () => {
    const { guard } = setup(() => Promise.resolve(CLAIMS), {
      attachTokenAs: "identityClaims",
    });
    const request: FakeRequest = { headers: { authorization: "Bearer good" } };

    await guard.canActivate(contextFor(request));

    expect(request["identityClaims"]).toEqual(CLAIMS);
    expect(request["canopyToken"]).toBeUndefined();
    expect(request["user"]).toBeUndefined();
  });
});

describe("CanopyTokenGuard — refusing", () => {
  it.each([
    ["no header at all", undefined],
    ["an empty header", ""],
    ["the scheme alone", "Bearer"],
    ["a scheme with no token", "Bearer   "],
    ["a different scheme", "Basic dXNlcjpwYXNz"],
  ])("401s on %s", async (_label, authorization) => {
    const { guard, verifyMock } = setup(() => Promise.resolve(CLAIMS));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Nothing reached the verifier, so nothing was checked against the network.
    expect(verifyMock).not.toHaveBeenCalled();
  });

  /**
   * The one failure that is ours, not the caller's.
   *
   * A 401 here would tell a client its token is stale. It would discard a
   * perfectly good one and ask for another, aiming a refresh storm at an issuer
   * that is already down — and an outage emitting only 4xx is invisible to
   * anything alerting on 5xx.
   */
  it("503s when the key set cannot be read, rather than blaming the token", async () => {
    const { guard } = setup(() =>
      Promise.reject(
        new CanopyTokenError(
          "token.jwks_unavailable",
          "Could not reach the signing keys.",
        ),
      ),
    );
    const request: FakeRequest = { headers: { authorization: "Bearer good" } };

    const error = await guard
      .canActivate(contextFor(request))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).not.toBeInstanceOf(UnauthorizedException);
    expect(request["canopyToken"]).toBeUndefined();
  });

  it("401s when verification fails, and attaches nothing", async () => {
    const { guard } = setup(() =>
      Promise.reject(new CanopyTokenError("token.expired", "Token expired.")),
    );
    const request: FakeRequest = { headers: { authorization: "Bearer old" } };

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request["canopyToken"]).toBeUndefined();
  });

  /**
   * The reason every failure collapses to one message: which check failed is
   * useful in a log and useless to a caller, who cannot fix a bad signature by
   * being told it was the signature. The code stays on `cause`.
   */
  it("does not tell the caller which check failed", async () => {
    const { guard } = setup(() =>
      Promise.reject(
        new CanopyTokenError(
          "token.signature_invalid",
          "Signature does not match.",
        ),
      ),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "Bearer x" } })),
    ).rejects.toSatisfy((error: unknown) => {
      const message = (error as Error).message;

      // The same wording whatever failed, carrying neither the code nor the
      // verifier's own description of which check it was.
      return (
        message === "Invalid or expired access token." &&
        !message.includes("token.signature_invalid") &&
        !message.includes("Signature does not match")
      );
    });
  });

  it("keeps the token error as the cause, for logs", async () => {
    const cause = new CanopyTokenError("token.expired", "Token expired.");
    const { guard } = setup(() => Promise.reject(cause));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "Bearer x" } })),
    ).rejects.toSatisfy(
      (error: unknown) => (error as { cause?: unknown }).cause === cause,
    );
  });

  /**
   * A non-token failure — a bug in a custom fetch, say — is not a 401. Turning
   * it into one would report a server fault as the caller's fault and hide it
   * from every alert that watches 5xx.
   */
  it("lets an unexpected error through rather than calling it a 401", async () => {
    const boom = new TypeError("fetch is not a function");
    const { guard } = setup(() => Promise.reject(boom));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "Bearer x" } })),
    ).rejects.toBe(boom);
  });
});
