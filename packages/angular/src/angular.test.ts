import { Location } from "@angular/common";
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import {
  ApplicationInitStatus,
  Component,
  provideZonelessChangeDetection,
  type Provider,
  type EnvironmentProviders,
} from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { RouterStateSnapshot } from "@angular/router";
import {
  CanopyAuthError,
  CanopyBrowserClient,
  CanopyConnectionError,
} from "@canopy-io/browser";
import { afterEach, describe, expect, it } from "vitest";

import { CanopyAuth } from "./canopy-auth";
import { CanopyPermissions } from "./canopy-permissions";
import {
  CanopyCanDirective,
  CanopySignedInDirective,
  CanopySignedOutDirective,
} from "./directives";
import { canopyAuthGuard } from "./guard";
import { canopyAuthInterceptor } from "./interceptor";
import { provideCanopy, type CanopyProviderOptions } from "./provide-canopy";
import { FakeClient, REFUSED } from "./testing/fake-client";

afterEach(() => {
  TestBed.resetTestingModule();
});

function setUp(
  fake: FakeClient,
  options: CanopyProviderOptions = {},
  providers: (Provider | EnvironmentProviders)[] = [],
): void {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideCanopy({ client: fake.asClient(), ...options }),
      ...providers,
    ],
  });
}

/** Run the app initializers, as bootstrap does; settle with `start()`. */
function initializing(): Promise<unknown> {
  return TestBed.inject(ApplicationInitStatus).donePromise;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
}

describe("provideCanopy", () => {
  it("starts once and puts the page the sign-in started on in the address bar", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const done = initializing();

    fake.setSignedIn();
    fake.finishStart({
      status: "signed-in",
      returnTo: "/projects/5?tab=a#top",
    });
    await done;

    expect(fake.startCalls).toEqual([{}]);
    expect(TestBed.inject(Location).path(true)).toBe("/projects/5?tab=a#top");
  });

  it("passes resume: false to start", async () => {
    const fake = new FakeClient();

    setUp(fake, { resume: false });

    const done = initializing();

    fake.setSignedOut();
    fake.finishStart({ status: "signed-out" });
    await done;

    expect(fake.startCalls).toEqual([{ resume: false }]);
  });

  it("holds a connection error on CanopyAuth.error instead of failing bootstrap", async () => {
    const fake = new FakeClient();
    const refused = new CanopyConnectionError(
      "https://auth.example.com",
      new TypeError("x"),
    );

    setUp(fake);

    const done = initializing();

    fake.failStart(refused);
    await done;

    expect(TestBed.inject(CanopyAuth).error()).toBe(refused);
  });

  it("creates a client from options without touching the network", () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideCanopy({
          issuer: "https://auth.example.com",
          clientId: "client_1",
          redirectUri: "http://localhost/callback",
        }),
      ],
    });

    expect(TestBed.inject(CanopyAuth).status()).toBe("loading");
    expect(
      new CanopyBrowserClient({
        issuer: "https://auth.example.com",
        clientId: "client_1",
        redirectUri: "https://app.example.com/callback",
      }),
    ).toBeTruthy();
  });
});

describe("CanopyAuth", () => {
  it("follows sign-in, refresh and sign-out", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const auth = TestBed.inject(CanopyAuth);

    expect(auth.isLoading()).toBe(true);
    expect(auth.user()).toBeNull();

    fake.setSignedIn(
      { email: "ada@example.com" },
      { org_id: "org_1", org_roles: ["admin"] },
    );

    expect(auth.isSignedIn()).toBe(true);
    expect(auth.user()?.email).toBe("ada@example.com");
    expect(auth.organization()).toEqual({
      orgId: "org_1",
      orgRoles: ["admin"],
      orgScope: null,
    });

    fake.setSignedIn(
      { email: "ada@example.com" },
      { org_id: "org_2", org_roles: [] },
    );

    expect(auth.organization().orgId).toBe("org_2");

    await auth.signOut();

    expect(fake.signOuts).toBe(1);
    expect(auth.status()).toBe("signed-out");
    expect(auth.user()).toBeNull();
    expect(auth.organization().orgId).toBeNull();
  });

  it("surfaces Canopy's refusal and hands out the token", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const auth = TestBed.inject(CanopyAuth);
    const refused = new CanopyAuthError("login_required");

    fake.setSignedOut(refused);

    expect(auth.error()).toBe(refused);
    await expect(auth.getAccessToken()).resolves.toBeNull();

    fake.setSignedIn();

    await expect(auth.getAccessToken()).resolves.toBe("access-token");
  });

  it("switches organization with a round trip back to the current page", async () => {
    const fake = new FakeClient();

    setUp(fake);
    TestBed.inject(Location).replaceState("/settings", "x=1");
    await TestBed.inject(CanopyAuth).switchOrganization("org_2");

    expect(fake.signIns).toEqual([
      { organization: "org_2", returnTo: "/settings?x=1" },
    ]);
  });

  it("reads the organization list only once signed in, and holds it", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const auth = TestBed.inject(CanopyAuth);
    const list = auth.organizationList();

    expect(list()).toEqual({ organizations: [], isLoading: true, error: null });
    await flush();

    expect(fake.organizationCalls).toBe(0);

    fake.setSignedIn();
    list();
    await flush();

    expect(fake.organizationCalls).toBe(1);

    const acme = {
      id: "org_1",
      name: "Acme",
      slug: "acme",
      roles: [],
      administers: false,
      portal_access: false,
    };

    fake.setOrganizations({ status: "loaded", organizations: [acme] });

    expect(list().organizations).toEqual([acme]);

    list();
    await flush();

    expect(fake.organizationCalls).toBe(1);
  });
});

describe("CanopyPermissions", () => {
  it("fails closed while loading and asks only once signed in", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const can = TestBed.inject(CanopyPermissions).can("deals.write", {
      nodeId: "node_1",
    });

    expect(can()).toEqual({ allowed: false, isLoading: true, error: null });
    await flush();

    expect(fake.asked).toEqual([]);

    fake.setSignedIn();

    expect(can().allowed).toBe(false);
    await flush();

    expect(fake.asked).toEqual([
      [{ permission: "deals.write", nodeId: "node_1" }],
    ]);
  });

  it("follows an answer, a cleared cache and an error, with one signal per check", async () => {
    const fake = new FakeClient();

    setUp(fake);

    const permissions = TestBed.inject(CanopyPermissions);
    const can = permissions.can("deals.write", { nodeId: "node_1" });

    expect(permissions.can("deals.write", { nodeId: "node_1" })).toBe(can);

    fake.setSignedIn();
    can();
    await flush();
    fake.answer("deals.write", "node_1", { status: "allowed" });

    expect(can()).toEqual({ allowed: true, isLoading: false, error: null });

    fake.clearAnswers();

    expect(can()).toEqual({ allowed: false, isLoading: true, error: null });

    fake.answer("deals.write", "node_1", { status: "error", error: REFUSED });

    expect(can()).toEqual({ allowed: false, isLoading: false, error: REFUSED });
  });
});

describe("canopyAuthGuard", () => {
  const route = {} as never;
  const state = (url: string) => ({ url }) as RouterStateSnapshot;

  it("admits a signed-in person", () => {
    const fake = new FakeClient();

    setUp(fake);
    fake.setSignedIn();

    expect(
      TestBed.runInInjectionContext(() =>
        canopyAuthGuard(route, state("/report")),
      ),
    ).toBe(true);
    expect(fake.signIns).toEqual([]);
  });

  it("sends anyone else to sign in, coming back to the target", () => {
    const fake = new FakeClient();

    setUp(fake);
    fake.setSignedOut();

    expect(
      TestBed.runInInjectionContext(() =>
        canopyAuthGuard(route, state("/report?quarter=q4")),
      ),
    ).toBe(false);
    expect(fake.signIns).toEqual([{ returnTo: "/report?quarter=q4" }]);
  });
});

describe("canopyAuthInterceptor", () => {
  it("attaches the token to the listed origins only", async () => {
    const fake = new FakeClient();

    setUp(fake, { apiOrigins: ["https://api.example.com/"] }, [
      provideHttpClient(withInterceptors([canopyAuthInterceptor])),
      provideHttpClientTesting(),
    ]);
    fake.setSignedIn();

    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);

    http.get("https://api.example.com/deals").subscribe();
    http.get("https://elsewhere.example.com/data").subscribe();
    http
      .get("https://api.example.com/other", {
        headers: { Authorization: "Basic abc" },
      })
      .subscribe();
    await flush();

    expect(
      backend
        .expectOne("https://api.example.com/deals")
        .request.headers.get("Authorization"),
    ).toBe("Bearer access-token");
    expect(
      backend
        .expectOne("https://elsewhere.example.com/data")
        .request.headers.has("Authorization"),
    ).toBe(false);
    expect(
      backend
        .expectOne("https://api.example.com/other")
        .request.headers.get("Authorization"),
    ).toBe("Basic abc");
    backend.verify();
  });
});

@Component({
  imports: [
    CanopyCanDirective,
    CanopySignedInDirective,
    CanopySignedOutDirective,
  ],
  template: `
    <p *canopySignedIn>in</p>
    <p *canopySignedOut>out</p>
    <button *canopyCan="'deals.write'; nodeId: 'node_1'; else: denied">
      edit
    </button>
    <ng-template #denied><span>read only</span></ng-template>
  `,
})
class Host {}

describe("directives", () => {
  function render(fake: FakeClient): { text: () => Promise<string> } {
    setUp(fake);

    const fixture = TestBed.createComponent(Host);
    const text = async () => {
      fixture.detectChanges();
      await fixture.whenStable();

      const root = fixture.nativeElement as HTMLElement;

      return Array.from(root.querySelectorAll<HTMLElement>("p, button, span"))
        .map((element) => element.textContent?.trim())
        .join(" ");
    };

    return { text };
  }

  it("show neither sign-in state while loading, and the else template", async () => {
    const { text } = render(new FakeClient());

    expect(await text()).toBe("read only");
  });

  it("follow the session, the answer arriving and the cache clearing", async () => {
    const fake = new FakeClient();
    const { text } = render(fake);

    fake.setSignedOut();

    expect(await text()).toBe("out read only");

    fake.setSignedIn();

    expect(await text()).toBe("in read only");

    fake.answer("deals.write", "node_1", { status: "allowed" });

    expect(await text()).toBe("in edit");

    fake.clearAnswers();

    expect(await text()).toBe("in read only");
  });
});
