/**
 * Seals a value for a cookie: AES-256-GCM under a key derived from the app's
 * secret, so the browser holds it but can neither read nor change it. A
 * cookie that fails to open is treated as absent.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);

  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );

      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode("canopy-nextjs session cookie"),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keys.set(secret, key);
  }

  return key;
}

export async function seal(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const bytes = new Uint8Array(IV_BYTES + sealed.byteLength);

  bytes.set(iv, 0);
  bytes.set(new Uint8Array(sealed), IV_BYTES);

  return `${VERSION}.${toBase64Url(bytes)}`;
}

export async function open<T>(
  sealed: string,
  secret: string,
): Promise<T | null> {
  const [version, body] = sealed.split(".");

  if (version !== VERSION || !body) {
    return null;
  }

  try {
    const bytes = fromBase64Url(body);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await keyFor(secret),
      bytes.slice(IV_BYTES),
    );

    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
