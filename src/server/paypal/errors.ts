import "server-only";

// How a PayPal call failed, in the terms the app acts on:
// not_configured: no keys on this server · auth: PayPal refused the credentials or the token
// unavailable: 5xx, network error, timeout or an unreadable answer (trying again is safe)
// rejected: PayPal refused the request itself (400, 406, 422) · not_found: no such invoice (404)
export const PAYPAL_FAILURES = ["not_configured", "auth", "unavailable", "rejected", "not_found"] as const;
export type PayPalFailure = (typeof PAYPAL_FAILURES)[number];

// The message holds only the HTTP status, PayPal's issue name and its debug id: never a request header,
// a token, or a body, so it is safe to log.
export class PayPalError extends Error {
  constructor(
    readonly failure: PayPalFailure,
    readonly httpStatus: number | null, // null when no response arrived (network error, timeout)
    readonly issue: string | null, // details[0].issue, the OAuth "error", or the error name
    readonly debugId: string | null, // body debug_id, else the paypal-debug-id header
  ) {
    super(`PayPal ${failure} (${httpStatus ?? "no response"}${issue ? `, ${issue}` : ""})`);
    this.name = "PayPalError";
  }
}

export function failureForStatus(status: number): PayPalFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  // 429 is a rate limit: nothing was decided, so it is worth another try like a 5xx.
  if (status === 429 || status >= 500) return "unavailable";
  return "rejected";
}

// PayPal names and ids are short codes. Anything else is dropped rather than logged.
const ISSUE = /^[A-Za-z0-9_.-]{1,80}$/;
const DEBUG_ID = /^[A-Za-z0-9-]{1,64}$/;

function code(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

// Reads an error body. Two 401 shapes exist: OAuth's {"error":"invalid_token"} and REST's
// {"name":"AUTHENTICATION_FAILURE"}; 4xx validation errors carry details[0].issue.
export function parseErrorBody(text: string, debugHeader: string | null = null): { issue: string | null; debugId: string | null } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const details = field(body, "details");
  const firstIssue = Array.isArray(details) ? field(details[0], "issue") : undefined;
  return {
    issue: code(firstIssue, ISSUE) ?? code(field(body, "error"), ISSUE) ?? code(field(body, "name"), ISSUE),
    debugId: code(field(body, "debug_id"), DEBUG_ID) ?? code(debugHeader, DEBUG_ID),
  };
}
