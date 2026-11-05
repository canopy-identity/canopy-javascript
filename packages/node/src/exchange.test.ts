import { describe, expect, it, vi } from "vitest";

import { isCanopyConnectionError, isCanopyError } from "./errors.js";
import {
  ACCESS_TOKEN_TYPE,
  exchangeToken,
  TOKEN_EXCHANGE_GRANT,
} from "./exchange.js";

/**
 * A machine client trading a person's access token for a delegated one. The
 * request is RFC 8693's; the refusals arrive in the OAuth error shape and
 * leave as the client's own errors.
 */

const OPTIONS = {
  clientId: "client_abc",
  clientSecret: "s3cr%t:x",
  subjectToken: "person.jwt",
  baseUrl: "https://auth.example.test/",
};

function answering(status: number, body: unknown, headers = {}) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  );
}

describe("exchangeToken", () => {
  it("posts the exchange with the client's credentials", async () => {
    const fetch = answering(200, {
      access_token: "delegated.jwt",
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: 300,
      scope: "permissions",
    });

    const token = await exchangeToken({
      ...OPTIONS,
      audience: "https://api.example.com",
      fetch,
    });

    expect(token).toEqual({
      accessToken: "delegated.jwt",
      tokenType: "Bearer",
      expiresIn: 300,
      scope: "permissions",
      issuedTokenType: ACCESS_TOKEN_TYPE,
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    const sent = new URLSearchParams(init?.body as string);
    const authorization = (init?.headers as Record<string, string>)[
      "Authorization"
    ];

    expect(url).toBe("https://auth.example.test/oauth/token");
    expect(sent.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT);
    expect(sent.get("subject_token")).toBe("person.jwt");
    expect(sent.get("subject_token_type")).toBe(ACCESS_TOKEN_TYPE);
    expect(sent.get("audience")).toBe("https://api.example.com");
    expect(sent.has("actor_token")).toBe(false);
    expect(atob(authorization?.replace("Basic ", "") ?? "")).toBe(
      "client_abc:s3cr%25t%3Ax",
    );
  });

  it("throws the OAuth refusal as a CanopyError with its code", async () => {
    const fetch = answering(400, {
      error: "invalid_grant",
      error_description: "The person is no longer signed in.",
    });

    const error = await exchangeToken({ ...OPTIONS, fetch }).catch(
      (e: unknown) => e,
    );

    expect(isCanopyError(error)).toBe(true);
    expect(error).toMatchObject({
      statusCode: 400,
      code: "oauth.invalid_grant",
      message: "The person is no longer signed in.",
    });
  });

  it("carries Retry-After when the client asked too often", async () => {
    const fetch = answering(
      429,
      { error: "invalid_request", error_description: "Too many tokens." },
      { "Retry-After": "12" },
    );

    await expect(exchangeToken({ ...OPTIONS, fetch })).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 12_000,
    });
  });

  it("throws a connection error when the endpoint never answers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));

    const error = await exchangeToken({ ...OPTIONS, fetch }).catch(
      (e: unknown) => e,
    );

    expect(isCanopyConnectionError(error)).toBe(true);
  });
});
