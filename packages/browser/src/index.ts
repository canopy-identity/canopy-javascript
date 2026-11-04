export {
  CanopyBrowserClient,
  createCanopyBrowserClient,
  type CanopyBrowserClientOptions,
  type PendingStorage,
  type SignInOptions,
  type SignInResult,
} from "./client.js";
export {
  CanopyAuthError,
  CanopyConnectionError,
  isCanopyAuthError,
  isCanopyConnectionError,
} from "./errors.js";
export type { IdTokenClaims } from "./id-token.js";
