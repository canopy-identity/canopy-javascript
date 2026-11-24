// @vitest-environment node
import "@angular/compiler";

import {
  Component,
  inject,
  provideZonelessChangeDetection,
} from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import {
  provideServerRendering,
  renderApplication,
} from "@angular/platform-server";
import { CanopyBrowserClient } from "@canopy-io/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanopyAuth } from "./canopy-auth";
import { CanopyPermissions } from "./canopy-permissions";
import {
  CanopyCanDirective,
  CanopySignedInDirective,
  CanopySignedOutDirective,
} from "./directives";
import { provideCanopy } from "./provide-canopy";

/**
 * Rendered as Angular renders a page on the server: in Node, with no
 * `window` or `sessionStorage`, and with `provideCanopy` creating its own
 * browser client from options rather than a stand-in.
 */
@Component({
  selector: "app-root",
  imports: [
    CanopyCanDirective,
    CanopySignedInDirective,
    CanopySignedOutDirective,
  ],
  template: `
    <p id="status">{{ auth.status() }}|{{ editing().isLoading }}</p>
    <span *canopySignedIn>signed-in-content</span>
    <span *canopySignedOut>signed-out-content</span>
    <span *canopyCan="'deals.update'; nodeId: 'node_1'; else: readOnly"
      >can-content</span
    >
    <ng-template #readOnly><span>can-fallback</span></ng-template>
  `,
})
class AppRoot {
  readonly auth = inject(CanopyAuth);
  readonly editing = inject(CanopyPermissions).can("deals.update", {
    nodeId: "node_1",
  });
}

function render(): Promise<string> {
  return renderApplication(
    (context) =>
      bootstrapApplication(
        AppRoot,
        {
          providers: [
            provideZonelessChangeDetection(),
            provideServerRendering(),
            provideCanopy({
              issuer: "https://canopy-io.com/environments/env_1",
              clientId: "client_1",
              redirectUri: "https://app.example.com/callback",
            }),
          ],
        },
        context,
      ),
    {
      document: "<html><head></head><body><app-root></app-root></body></html>",
      url: "/reports",
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("on the server", () => {
  it("runs where no browser global exists", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof sessionStorage).toBe("undefined");
  });

  it("renders the loading state, and nothing signed-in or signed-out", async () => {
    const html = await render();

    expect(html).toContain("loading|true");
    expect(html).not.toContain("signed-in-content");
    expect(html).not.toContain("signed-out-content");
    expect(html).not.toContain("can-content");
    expect(html).toContain("can-fallback");
  });

  it("never starts the client and sends no request", async () => {
    const start = vi.spyOn(CanopyBrowserClient.prototype, "start");
    const fetchSpy = vi.fn();

    vi.stubGlobal("fetch", fetchSpy);
    await render();

    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
