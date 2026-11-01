import { withoutTrailingSlashes } from "./strings.js";

/** Canopy's hosted origin: where the client calls and whose Environments issue tokens. */
const HOSTED_ORIGIN = "https://auth.canopy-io.com";

/**
 * The Canopy origin this process talks to.
 *
 * Canopy's hosted origin unless `CANOPY_BASE_URL` is set, which a self-hosted
 * instance, a test stack or a proxy sets once for the whole process instead of
 * passing `baseUrl` to every client and `issuer` to every verifier. An
 * explicit option still wins over it. Read through `globalThis` so the package
 * stays usable in browsers, Workers and Deno, where there is no `process`.
 */
export function hostedOrigin(): string {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const configured = env?.["CANOPY_BASE_URL"]?.trim();

  return withoutTrailingSlashes(configured || HOSTED_ORIGIN);
}
