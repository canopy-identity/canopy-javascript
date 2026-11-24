import {
  CanopyAuthError,
  CanopyBrowserClient,
  CanopyConnectionError,
} from "@canopy-io/browser";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Can, RequireAuth, SignedIn, SignedOut } from "./components.js";
import { FakeClient, REFUSED } from "./fake-client.js";
import {
  useAccessToken,
  useAuth,
  useOrganization,
  useOrganizationList,
  usePermission,
  usePermissions,
  useUser,
} from "./hooks.js";
import { CanopyProvider } from "./index.js";

afterEach(() => {
  cleanup();
});

function wrap(
  fake: FakeClient,
  extra: { onRedirectCallback?: (returnTo: string) => void } = {},
): (props: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }) {
    return (
      <StrictMode>
        <CanopyProvider client={fake.asClient()} {...extra}>
          {children}
        </CanopyProvider>
      </StrictMode>
    );
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CanopyProvider", () => {
  it("starts once under StrictMode and hands the page back once", async () => {
    const fake = new FakeClient();
    const onRedirectCallback = vi.fn();

    renderHook(() => useAuth(), {
      wrapper: wrap(fake, { onRedirectCallback }),
    });

    await act(async () => {
      fake.setSignedIn();
      fake.finishStart({ status: "signed-in", returnTo: "/projects/5?tab=a" });
      await Promise.resolve();
    });

    expect(fake.startCalls.length).toBeGreaterThanOrEqual(1);
    expect(onRedirectCallback).toHaveBeenCalledTimes(1);
    expect(onRedirectCallback).toHaveBeenCalledWith("/projects/5?tab=a");
  });

  it("replaces the address with returnTo when no callback is given", async () => {
    const fake = new FakeClient();

    renderHook(() => useAuth(), { wrapper: wrap(fake) });

    await act(async () => {
      fake.setSignedIn();
      fake.finishStart({ status: "signed-in", returnTo: "/deep/link#part" });
      await Promise.resolve();
    });

    expect(`${location.pathname}${location.hash}`).toBe("/deep/link#part");
  });

  it("passes resume: false to start", () => {
    const fake = new FakeClient();

    render(
      <CanopyProvider client={fake.asClient()} resume={false}>
        <span />
      </CanopyProvider>,
    );

    expect(fake.startCalls[0]).toEqual({ resume: false });
  });

  it("surfaces a connection error on useAuth", async () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrap(fake) });
    const refused = new CanopyConnectionError(
      "https://auth.example.com",
      new TypeError("x"),
    );

    await act(async () => {
      fake.failStart(refused);
      await Promise.resolve();
    });

    expect(result.current.error).toBe(refused);
  });

  it("creates a client from options and starts it without touching the network", async () => {
    const fetch = vi.fn();

    function Status(): ReactNode {
      return <span>{useAuth().status}</span>;
    }

    render(
      <CanopyProvider
        issuer="https://auth.example.com"
        clientId="client_1"
        redirectUri="http://localhost:3000/callback"
        fetch={fetch}
        resume={false}
      >
        <Status />
      </CanopyProvider>,
    );

    await settle();

    expect(screen.getByText("signed-out")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a hook rendered outside it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => renderHook(() => useAuth())).toThrow(/CanopyProvider/);
  });

  it("constructs on the server without a browser global", () => {
    expect(
      () =>
        new CanopyBrowserClient({
          issuer: "https://auth.example.com",
          clientId: "client_1",
          redirectUri: "https://app.example.com/callback",
        }),
    ).not.toThrow();
  });
});

describe("session hooks", () => {
  it("re-render on sign-in, refresh and sign-out", async () => {
    const fake = new FakeClient();
    const { result } = renderHook(
      () => ({ auth: useAuth(), user: useUser<{ plan?: string }>() }),
      { wrapper: wrap(fake) },
    );

    expect(result.current.auth.isLoading).toBe(true);
    expect(result.current.user).toBeNull();

    act(() => {
      fake.setSignedIn({ email: "ada@example.com" });
    });

    expect(result.current.auth.isSignedIn).toBe(true);
    expect(result.current.user?.email).toBe("ada@example.com");

    act(() => {
      fake.setSignedIn({ email: "ada@example.com", plan: "pro" });
    });

    expect(result.current.user?.plan).toBe("pro");

    await act(async () => {
      await result.current.auth.signOut();
    });

    expect(fake.signOuts).toBe(1);
    expect(result.current.auth.status).toBe("signed-out");
    expect(result.current.user).toBeNull();
  });

  it("surface Canopy's refusal on useAuth", () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrap(fake) });
    const refused = new CanopyAuthError("login_required");

    act(() => {
      fake.setSignedOut(refused);
    });

    expect(result.current.error).toBe(refused);
    expect(result.current.error).toBeInstanceOf(CanopyAuthError);
  });

  it("hand out a stable access token reader", async () => {
    const fake = new FakeClient();
    const { result, rerender } = renderHook(() => useAccessToken(), {
      wrapper: wrap(fake),
    });
    const first = result.current;

    act(() => {
      fake.setSignedIn();
    });
    rerender();

    expect(result.current).toBe(first);
    await expect(result.current()).resolves.toBe("access-token");
  });

  it("read the organization from the access token and switch it", async () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useOrganization(), {
      wrapper: wrap(fake),
    });

    expect(result.current.orgId).toBeNull();

    act(() => {
      fake.setSignedIn({}, { org_id: "org_1", org_roles: ["admin"] });
    });

    expect(result.current.orgId).toBe("org_1");
    expect(result.current.orgRoles).toEqual(["admin"]);
    expect(result.current.orgScope).toBeNull();

    history.replaceState(null, "", "/settings?x=1");
    await act(async () => {
      await result.current.switchOrganization("org_2");
    });

    expect(fake.signIns).toEqual([
      { organization: "org_2", returnTo: "/settings?x=1" },
    ]);
  });
});

describe("useAuth shortcuts", () => {
  it("carry the user, the organization and the token reader", async () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrap(fake) });

    expect(result.current.userId).toBeNull();
    expect(result.current.orgId).toBeNull();

    act(() => {
      fake.setSignedIn({ sub: "id_7" }, { org_id: "org_1" });
    });

    expect(result.current.userId).toBe("id_7");
    expect(result.current.orgId).toBe("org_1");
    await expect(result.current.getAccessToken()).resolves.toBe("access-token");
  });
});

describe("useOrganizationList", () => {
  const ACME = {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    roles: [{ id: "role_1", name: "Admin" }],
    administers: true,
    portal_access: true,
  };

  it("asks only once signed in, shows the list, and asks nothing once held", () => {
    const fake = new FakeClient();
    const { result, rerender } = renderHook(() => useOrganizationList(), {
      wrapper: wrap(fake),
    });

    expect(result.current).toEqual({
      organizations: [],
      isLoading: true,
      error: null,
    });
    expect(fake.organizationCalls).toBe(0);

    act(() => {
      fake.setSignedIn();
    });

    expect(fake.organizationCalls).toBeGreaterThan(0);

    act(() => {
      fake.setOrganizations({ status: "loaded", organizations: [ACME] });
    });

    const calls = fake.organizationCalls;

    rerender();
    rerender();

    expect(result.current).toEqual({
      organizations: [ACME],
      isLoading: false,
      error: null,
    });
    expect(fake.organizationCalls).toBe(calls);
  });

  it("exposes an error and shows no organizations", () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useOrganizationList(), {
      wrapper: wrap(fake),
    });

    act(() => {
      fake.setSignedIn();
      fake.setOrganizations({ status: "error", error: REFUSED });
    });

    expect(result.current).toEqual({
      organizations: [],
      isLoading: false,
      error: REFUSED,
    });
  });

  it("is empty and asks nothing once signed out", () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => useOrganizationList(), {
      wrapper: wrap(fake),
    });

    act(() => {
      fake.setSignedOut();
    });

    expect(result.current).toEqual({
      organizations: [],
      isLoading: false,
      error: null,
    });
    expect(fake.organizationCalls).toBe(0);
  });
});

describe("permission hooks", () => {
  it("fail closed while loading and ask only once signed in", () => {
    const fake = new FakeClient();
    const { result } = renderHook(
      () => usePermission("deals.read", { nodeId: "node_1" }),
      { wrapper: wrap(fake) },
    );

    expect(result.current).toEqual({
      allowed: false,
      isLoading: true,
      error: null,
    });
    expect(fake.asked).toEqual([]);

    act(() => {
      fake.setSignedIn();
    });

    expect(result.current.allowed).toBe(false);
    expect(result.current.isLoading).toBe(true);
    expect(fake.asked).toEqual([
      [{ permission: "deals.read", nodeId: "node_1" }],
    ]);
  });

  it("re-render when the answer arrives and when the held answers clear", () => {
    const fake = new FakeClient();
    const { result } = renderHook(
      () => usePermission("deals.read", { nodeId: "node_1" }),
      { wrapper: wrap(fake) },
    );

    act(() => {
      fake.setSignedIn();
    });
    act(() => {
      fake.answer("deals.read", "node_1", { status: "allowed" });
    });

    expect(result.current).toEqual({
      allowed: true,
      isLoading: false,
      error: null,
    });

    act(() => {
      fake.clearAnswers();
    });

    expect(result.current).toEqual({
      allowed: false,
      isLoading: true,
      error: null,
    });
    expect(fake.asked).toEqual([
      [{ permission: "deals.read", nodeId: "node_1" }],
    ]);
  });

  it("hide on an error and expose it", () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => usePermission("deals.read"), {
      wrapper: wrap(fake),
    });

    act(() => {
      fake.setSignedIn();
    });
    act(() => {
      fake.answer("deals.read", undefined, { status: "error", error: REFUSED });
    });

    expect(result.current).toEqual({
      allowed: false,
      isLoading: false,
      error: REFUSED,
    });
  });

  it("report nothing allowed once signed out", () => {
    const fake = new FakeClient();
    const { result } = renderHook(() => usePermission("deals.read"), {
      wrapper: wrap(fake),
    });

    act(() => {
      fake.setSignedOut();
    });

    expect(result.current).toEqual({
      allowed: false,
      isLoading: false,
      error: null,
    });
    expect(fake.asked).toEqual([]);
  });

  it("ask several checks together and keep a new array with the same checks stable", () => {
    const fake = new FakeClient();
    const { result, rerender } = renderHook(
      () =>
        usePermissions([
          { permission: "deals.read", nodeId: "node_1" },
          { permission: "deals.write", nodeId: "node_2" },
        ]),
      { wrapper: wrap(fake) },
    );

    act(() => {
      fake.setSignedIn();
    });

    const before = result.current;

    rerender();

    expect(result.current).toBe(before);
    expect(fake.asked).toEqual([
      [
        { permission: "deals.read", nodeId: "node_1" },
        { permission: "deals.write", nodeId: "node_2" },
      ],
    ]);

    act(() => {
      fake.answer("deals.write", "node_2", {
        status: "denied",
        reason: "no_grant",
      });
      fake.answer("deals.read", "node_1", { status: "allowed" });
    });

    expect(result.current.map((answer) => answer.allowed)).toEqual([
      true,
      false,
    ]);
  });
});

describe("components", () => {
  function app(fake: FakeClient, children: ReactNode): ReactNode {
    return (
      <StrictMode>
        <CanopyProvider client={fake.asClient()}>{children}</CanopyProvider>
      </StrictMode>
    );
  }

  it("SignedIn and SignedOut follow the session, showing neither while loading", () => {
    const fake = new FakeClient();

    render(
      app(
        fake,
        <>
          <SignedIn>in</SignedIn>
          <SignedOut>out</SignedOut>
        </>,
      ),
    );

    expect(screen.queryByText("in")).toBeNull();
    expect(screen.queryByText("out")).toBeNull();

    act(() => {
      fake.setSignedOut();
    });

    expect(screen.getByText("out")).toBeTruthy();

    act(() => {
      fake.setSignedIn();
    });

    expect(screen.getByText("in")).toBeTruthy();
    expect(screen.queryByText("out")).toBeNull();
  });

  it("RequireAuth signs a signed-out reader in, coming back to the page", () => {
    const fake = new FakeClient();

    history.replaceState(null, "", "/projects/5?tab=b#top");
    render(app(fake, <RequireAuth fallback="wait">secret</RequireAuth>));

    expect(screen.getByText("wait")).toBeTruthy();

    act(() => {
      fake.setSignedOut();
    });

    expect(screen.queryByText("secret")).toBeNull();
    expect(fake.signIns.at(-1)).toEqual({ returnTo: "/projects/5?tab=b#top" });

    act(() => {
      fake.setSignedIn();
    });

    expect(screen.getByText("secret")).toBeTruthy();
  });

  it("Can shows its fallback until the person holds the permission", () => {
    const fake = new FakeClient();

    render(
      app(
        fake,
        <Can permission="deals.write" nodeId="node_1" fallback="no">
          edit
        </Can>,
      ),
    );

    act(() => {
      fake.setSignedIn();
    });

    expect(screen.getByText("no")).toBeTruthy();

    act(() => {
      fake.answer("deals.write", "node_1", { status: "allowed" });
    });

    expect(screen.getByText("edit")).toBeTruthy();
  });
});
