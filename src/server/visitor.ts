// The demo visitor cookie. proxy.ts imports this file, so it uses Web APIs only: no "server-only", no database.

export const VISITOR_COOKIE = "tg_visitor";
// Same as the life of a demo copy; the cookie is issued only when missing, never extended.
export const VISITOR_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

export interface VisitorCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// 256 random bits as unpadded base64url (43 characters), so an id can't be guessed.
export function newVisitorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isVisitorId(value: unknown): value is string {
  return typeof value === "string" && VISITOR_ID_PATTERN.test(value);
}

export function visitorCookieOptions(secure: boolean): VisitorCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: VISITOR_COOKIE_MAX_AGE_S };
}
