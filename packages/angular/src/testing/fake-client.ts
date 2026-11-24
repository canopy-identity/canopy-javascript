import {
  CanopyAuthError,
  type AccessTokenClaims,
  type CanopyBrowserClient,
  type IdTokenClaims,
  type Organization,
  type OrganizationsState,
  type PermissionCheck,
  type PermissionState,
  type SessionSnapshot,
  type SignInOptions,
  type SignInResult,
  type StartOptions,
} from "@canopy-io/browser";

const LOADING: PermissionState = Object.freeze({ status: "loading" });

/**
 * A stand-in for the browser client with the parts the wrapper reads, driven
 * by each test. The client's own behaviour (one shared start, batching,
 * holding answers) is proven in `@canopy-io/browser`; these tests prove the
 * wrapper maps it into React.
 */
export class FakeClient {
  readonly startCalls: StartOptions[] = [];
  readonly signIns: SignInOptions[] = [];
  readonly asked: PermissionCheck[][] = [];
  signOuts = 0;
  /** Calls to `listOrganizations` while nothing was held. */
  organizationCalls = 0;

  #snapshot: SessionSnapshot = Object.freeze({
    status: "loading",
    claims: null,
    error: null,
  });
  #accessClaims: AccessTokenClaims | null = null;
  #states = new Map<string, PermissionState>();
  #organizations: OrganizationsState = Object.freeze({ status: "loading" });
  #listeners = new Set<() => void>();
  #starting: Promise<SignInResult> | undefined;
  #settleStart!: (result: SignInResult) => void;
  #failStart!: (error: unknown) => void;

  /** As the real client: one run, shared by every call. */
  start(options: StartOptions = {}): Promise<SignInResult> {
    this.startCalls.push(options);
    this.#starting ??= new Promise<SignInResult>((resolve, reject) => {
      this.#settleStart = resolve;
      this.#failStart = reject;
    });

    return this.#starting;
  }

  finishStart(result: SignInResult): void {
    this.#settleStart(result);
  }

  failStart(error: unknown): void {
    this.#failStart(error);
  }

  signIn(options: SignInOptions = {}): Promise<void> {
    this.signIns.push(options);

    return Promise.resolve();
  }

  signOut(): Promise<void> {
    this.signOuts += 1;
    this.setSignedOut();

    return Promise.resolve();
  }

  getAccessToken(): Promise<string | null> {
    return Promise.resolve(
      this.#snapshot.status === "signed-in" ? "access-token" : null,
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return this.#snapshot;
  }

  getAccessTokenClaims(): AccessTokenClaims | null {
    return this.#accessClaims;
  }

  getPermissionState(
    permission: string,
    options: { nodeId?: string } = {},
  ): PermissionState {
    return this.#states.get(keyOf(permission, options.nodeId)) ?? LOADING;
  }

  checkPermission(
    permission: string,
    options: { nodeId?: string } = {},
  ): Promise<boolean> {
    return this.checkPermissions([
      options.nodeId === undefined
        ? { permission }
        : { permission, nodeId: options.nodeId },
    ]).then(([allowed]) => allowed ?? false);
  }

  checkPermissions(checks: readonly PermissionCheck[]): Promise<boolean[]> {
    const unasked = checks.filter(
      (check) =>
        !this.asked.some((batch) =>
          batch.some(
            (seen) =>
              seen.permission === check.permission &&
              seen.nodeId === check.nodeId,
          ),
        ),
    );

    if (unasked.length > 0) {
      this.asked.push(unasked);
    }

    return Promise.resolve(checks.map(() => false));
  }

  getOrganizationsState(): OrganizationsState {
    return this.#organizations;
  }

  listOrganizations(): Promise<Organization[]> {
    if (this.#organizations.status === "loaded") {
      return Promise.resolve(this.#organizations.organizations);
    }

    this.organizationCalls += 1;

    return Promise.resolve([]);
  }

  setOrganizations(state: OrganizationsState): void {
    this.#organizations = Object.freeze(state);
    this.#emit();
  }

  setSignedIn(
    claims: Partial<IdTokenClaims> = {},
    accessClaims: Partial<AccessTokenClaims> = {},
  ): void {
    this.#snapshot = Object.freeze({
      status: "signed-in",
      claims: { sub: "id_1", ...claims } as IdTokenClaims,
      error: null,
    });
    this.#accessClaims = {
      sub: "id_1",
      iss: "https://auth.example.com",
      exp: 0,
      ...accessClaims,
    };
    this.#states.clear();
    this.#emit();
  }

  setSignedOut(error: CanopyAuthError | null = null): void {
    this.#snapshot = Object.freeze({
      status: "signed-out",
      claims: null,
      error,
    });
    this.#accessClaims = null;
    this.#states.clear();
    this.#emit();
  }

  answer(
    permission: string,
    nodeId: string | undefined,
    state: PermissionState,
  ): void {
    this.#states.set(keyOf(permission, nodeId), Object.freeze(state));
    this.#emit();
  }

  /** The token changed: every held answer is forgotten. */
  clearAnswers(): void {
    this.#states.clear();
    this.asked.length = 0;
    this.#emit();
  }

  asClient(): CanopyBrowserClient {
    return this as unknown as CanopyBrowserClient;
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export const REFUSED = new CanopyAuthError(
  "rate_limited",
  "Slow down",
  429,
  30,
);

function keyOf(permission: string, nodeId: string | undefined): string {
  return `${nodeId ?? ""}\u0000${permission}`;
}
