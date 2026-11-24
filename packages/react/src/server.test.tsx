// @vitest-environment node
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Can,
  CanopyProvider,
  RequireAuth,
  SignedIn,
  SignedOut,
  useAuth,
  useOrganizationList,
  usePermission,
} from "./index.js";

/**
 * Rendered as a framework renders a page on the server: in Node, with no
 * `window`, `document` or `sessionStorage`, and with the provider creating
 * its own browser client from options rather than a stand-in.
 */
const OPTIONS = {
  issuer: "https://canopy-io.com/environments/env_1",
  clientId: "client_1",
  redirectUri: "https://app.example.com/callback",
};

function Status() {
  const { status, isSignedIn } = useAuth();
  const { allowed, isLoading } = usePermission("deals.update", {
    nodeId: "node_1",
  });
  const organizations = useOrganizationList();

  return (
    <p>
      {status}|{String(isSignedIn)}|{String(allowed)}|{String(isLoading)}|
      {String(organizations.isLoading)}
    </p>
  );
}

function Page() {
  return (
    <CanopyProvider {...OPTIONS}>
      <Status />
      <SignedIn>signed-in-content</SignedIn>
      <SignedOut>signed-out-content</SignedOut>
      <RequireAuth fallback={<span>guarded-fallback</span>}>
        guarded-content
      </RequireAuth>
      <Can permission="deals.update" fallback={<span>can-fallback</span>}>
        can-content
      </Can>
    </CanopyProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("on the server", () => {
  it("runs where no browser global exists", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof sessionStorage).toBe("undefined");
  });

  it("renders the loading state, and nothing signed-in or signed-out", () => {
    // React separates adjacent text with comment markers.
    const html = renderToString(<Page />).replaceAll("<!-- -->", "");

    expect(html).toContain("loading|false|false|true|true");
    expect(html).not.toContain("signed-in-content");
    expect(html).not.toContain("signed-out-content");
    expect(html).not.toContain("guarded-content");
    expect(html).not.toContain("can-content");
    expect(html).toContain("guarded-fallback");
    expect(html).toContain("can-fallback");
  });

  it("sends no request and starts nothing", () => {
    const fetchSpy = vi.fn();

    vi.stubGlobal("fetch", fetchSpy);
    renderToString(<Page />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
