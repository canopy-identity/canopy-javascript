export {
  type AccessTokenClaims,
  CanopyBrowserClient,
  createCanopyBrowserClient,
  type CanopyBrowserClientOptions,
  type PendingStorage,
  type SessionSnapshot,
  type SignInOptions,
  type SignInResult,
  type StartOptions,
} from "./client.js";
export {
  CanopyAuthError,
  CanopyConnectionError,
  isCanopyAuthError,
  isCanopyConnectionError,
} from "./errors.js";
export type {
  CanopyCaptchaElement,
  CanopyCaptchaErrorDetail,
  CanopyCaptchaTokenDetail,
} from "./captcha.js";
export type { IdTokenClaims } from "./id-token.js";
export type { PermissionCheck, PermissionState } from "./permissions.js";
export type { Organization, OrganizationsState } from "./organizations.js";
