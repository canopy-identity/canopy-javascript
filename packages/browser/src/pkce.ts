/**
 * PKCE (RFC 7636) and the random values a sign-in needs, on the Web Crypto
 * API every supported browser has. S256 only: Canopy refuses `plain`.
 */

/** URL-safe base64 without padding, as RFC 7636 and JWTs use it. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

/** A high-entropy random string: 32 bytes, 43 characters once encoded. */
export function randomString(): string {
  const bytes = new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return base64UrlEncode(bytes);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomString();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}
