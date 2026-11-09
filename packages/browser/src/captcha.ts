/**
 * Types for `<canopy-captcha>`, the bot-protection widget a Direct API sign-in
 * page loads from `<api origin>/auth/static/canopy-captcha.js`. The script is
 * served by Canopy, so this package ships its types and no code.
 */

/** The detail of a `canopy-captcha:token` event: the challenge was solved. */
export interface CanopyCaptchaTokenDetail {
  token: string;
}

/** The detail of a `canopy-captcha:error` event. */
export interface CanopyCaptchaErrorDetail {
  message: string;
}

/**
 * The element. Attributes: `publishable-key` (required), `flow` (`login`, the
 * default, or `signup`) and `api-base` (the Canopy API origin, same origin when
 * left out).
 */
export interface CanopyCaptchaElement extends HTMLElement {
  /** The solved CAPTCHA to send as `captcha_token`, or null. */
  readonly token: string | null;
  /** The same as `token`. */
  getToken(): string | null;
  /** Clear the token and start a fresh challenge, after a refused attempt. */
  reset(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "canopy-captcha": CanopyCaptchaElement;
  }

  interface HTMLElementEventMap {
    "canopy-captcha:token": CustomEvent<CanopyCaptchaTokenDetail>;
    "canopy-captcha:error": CustomEvent<CanopyCaptchaErrorDetail>;
  }
}
