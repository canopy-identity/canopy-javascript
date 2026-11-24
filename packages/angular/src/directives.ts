import {
  Directive,
  effect,
  inject,
  Input,
  signal,
  TemplateRef,
  ViewContainerRef,
} from "@angular/core";

import { CanopyAuth } from "./canopy-auth";
import { CanopyPermissions } from "./canopy-permissions";

/** Renders `template` when `show`, else `otherwise`; switches only on change. */
class Switch {
  #shown: "then" | "else" | null = null;

  constructor(
    private readonly container: ViewContainerRef,
    private readonly template: TemplateRef<unknown>,
  ) {}

  render(show: boolean, otherwise: TemplateRef<unknown> | null): void {
    const next = show ? "then" : otherwise ? "else" : null;

    if (next === this.#shown) {
      return;
    }

    this.container.clear();

    if (next === "then") {
      this.container.createEmbeddedView(this.template);
    } else if (next === "else" && otherwise) {
      this.container.createEmbeddedView(otherwise);
    }

    this.#shown = next;
  }
}

/**
 * Renders its content when the signed-in person holds the permission, and
 * the `else` template otherwise (while the answer loads, on a denial and on
 * an error). Decides what the page shows; your API still authorizes every
 * request.
 *
 *   <button *canopyCan="'deals.write'; nodeId: team.id; else readOnly">Edit</button>
 */
@Directive({ selector: "[canopyCan]" })
export class CanopyCanDirective {
  readonly #permissions = inject(CanopyPermissions);
  readonly #switch = new Switch(inject(ViewContainerRef), inject(TemplateRef));
  readonly #permission = signal<string | null>(null);
  readonly #nodeId = signal<string | undefined>(undefined);
  readonly #else = signal<TemplateRef<unknown> | null>(null);

  /** The permission key, for example `deals.write`. */
  @Input() set canopyCan(permission: string) {
    this.#permission.set(permission);
  }

  /** The node to ask at, walking its ancestors; without one, anywhere in the Environment. */
  @Input() set canopyCanNodeId(nodeId: string | null | undefined) {
    this.#nodeId.set(nodeId ?? undefined);
  }

  /** Shown while the answer loads, on a denial and on an error. */
  @Input() set canopyCanElse(template: TemplateRef<unknown> | null) {
    this.#else.set(template);
  }

  constructor() {
    effect(() => {
      const permission = this.#permission();
      const nodeId = this.#nodeId();
      const allowed =
        permission !== null &&
        this.#permissions.can(
          permission,
          nodeId === undefined ? {} : { nodeId },
        )().allowed;

      this.#switch.render(allowed, this.#else());
    });
  }
}

/** Renders its content only while someone is signed in. */
@Directive({ selector: "[canopySignedIn]" })
export class CanopySignedInDirective {
  readonly #switch = new Switch(inject(ViewContainerRef), inject(TemplateRef));
  readonly #else = signal<TemplateRef<unknown> | null>(null);

  /** Shown otherwise, including while the session loads. */
  @Input() set canopySignedInElse(template: TemplateRef<unknown> | null) {
    this.#else.set(template);
  }

  constructor() {
    const auth = inject(CanopyAuth);

    effect(() => {
      this.#switch.render(auth.isSignedIn(), this.#else());
    });
  }
}

/**
 * Renders its content only once nobody is known to be signed in: never while
 * the session loads, so a sign-in button does not flash.
 */
@Directive({ selector: "[canopySignedOut]" })
export class CanopySignedOutDirective {
  readonly #switch = new Switch(inject(ViewContainerRef), inject(TemplateRef));

  constructor() {
    const auth = inject(CanopyAuth);

    effect(() => {
      this.#switch.render(auth.status() === "signed-out", null);
    });
  }
}
