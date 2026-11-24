import type { CanopyNextConfig } from "./config";
import { open, seal } from "./seal";

/** What the session cookie holds, sealed. Never sent to browser JavaScript. */
export interface StoredSession {
  /** The access token. */
  at: string;
  /** The refresh token, when Canopy issued one. */
  rt?: string;
  /** The ID token, kept for sign-out's `id_token_hint`. */
  it?: string;
  /** When the access token expires, in seconds since the epoch. */
  exp: number;
}

/** What the sign-in round trip needs back at the callback. */
export interface StoredTransaction {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

/** The cookies a request carries, as Next.js reads them. */
export interface CookieReader {
  getAll(): { name: string; value: string }[];
}

/** A cookie to set (`value` and options) or to clear (`value` empty, `maxAge` 0). */
export interface CookieWrite {
  name: string;
  value: string;
  maxAge: number;
}

export const SESSION_COOKIE = "canopy_session";
export const TRANSACTION_COOKIE = "canopy_tx";

/** Under the 4096-byte cookie limit with room for the name and attributes. */
const CHUNK_SIZE = 3800;
const TRANSACTION_MAX_AGE_SEC = 10 * 60;

export async function readSession(
  cookies: CookieReader,
  config: CanopyNextConfig,
): Promise<StoredSession | null> {
  const chunks = cookies
    .getAll()
    .map(({ name, value }) => ({ index: chunkIndex(name), value }))
    .filter(
      (chunk): chunk is { index: number; value: string } =>
        chunk.index !== null,
    )
    .sort((a, b) => a.index - b.index);

  if (chunks.length === 0) {
    return null;
  }

  const session = await open<StoredSession>(
    chunks.map((chunk) => chunk.value).join(""),
    config.secret,
  );

  return session &&
    typeof session.at === "string" &&
    typeof session.exp === "number"
    ? session
    : null;
}

/**
 * The cookies that store `session`, or clear it when it is `null`: one chunk
 * per 3,800 characters, and a clear for every chunk the request held beyond
 * the new count, so a shorter session never leaves a stale tail.
 */
export async function sessionWrites(
  session: StoredSession | null,
  existing: CookieReader,
  config: CanopyNextConfig,
): Promise<CookieWrite[]> {
  const held = existing
    .getAll()
    .map(({ name }) => chunkIndex(name))
    .filter((index): index is number => index !== null);
  const writes: CookieWrite[] = [];

  let count = 0;

  if (session) {
    const sealed = await seal(session, config.secret);

    for (let start = 0; start < sealed.length; start += CHUNK_SIZE) {
      writes.push({
        name: `${SESSION_COOKIE}.${count}`,
        value: sealed.slice(start, start + CHUNK_SIZE),
        maxAge: config.sessionMaxAgeSec,
      });
      count += 1;
    }
  }

  for (const index of held) {
    if (index >= count) {
      writes.push({ name: `${SESSION_COOKIE}.${index}`, value: "", maxAge: 0 });
    }
  }

  return writes;
}

export async function transactionWrite(
  transaction: StoredTransaction,
  config: CanopyNextConfig,
): Promise<CookieWrite> {
  return {
    name: TRANSACTION_COOKIE,
    value: await seal(transaction, config.secret),
    maxAge: TRANSACTION_MAX_AGE_SEC,
  };
}

export async function readTransaction(
  value: string | undefined,
  config: CanopyNextConfig,
): Promise<StoredTransaction | null> {
  return value ? open<StoredTransaction>(value, config.secret) : null;
}

/** HttpOnly, SameSite=Lax, and Secure whenever the app is served over HTTPS. */
export function cookieOptions(config: CanopyNextConfig, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.appUrl.startsWith("https:"),
    path: "/",
    maxAge,
  };
}

function chunkIndex(name: string): number | null {
  const prefix = `${SESSION_COOKIE}.`;

  if (!name.startsWith(prefix)) {
    return null;
  }

  const index = Number(name.slice(prefix.length));

  return Number.isInteger(index) && index >= 0 ? index : null;
}
