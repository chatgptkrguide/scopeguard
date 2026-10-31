import "server-only";
import { PayPalError } from "./errors";
import type { PayPalClient } from "./token";

// PayPal webhook signature verification by postback: POST /v1/notifications/verify-webhook-signature with the five
// signature headers, the webhook id, and the event exactly as it arrived. PayPal's docs warn that an event parsed
// and serialized again can fail verification, so the event is spliced into the request body as text.

const VERIFY = "/v1/notifications/verify-webhook-signature";

export const MAX_WEBHOOK_BYTES = 64 * 1024;

// The five signature headers PayPal sends with every notification (lower case, as Headers.get reads them).
export interface WebhookHeaders {
  authAlgo: string; // paypal-auth-algo, /^[A-Za-z0-9]{1,100}$/
  certUrl: string; // paypal-cert-url, an https URL, at most 500 characters
  transmissionId: string; // paypal-transmission-id, 1..50 characters, no spaces
  transmissionSig: string; // paypal-transmission-sig, 1..500 characters, no spaces
  transmissionTime: string; // paypal-transmission-time, 1..100 characters
}

// The limits PayPal's schema puts on each field (verify_webhook_signature).
const AUTH_ALGO = /^[A-Za-z0-9]{1,100}$/;
const NO_SPACES = /^\S+$/;

function httpsUrl(value: string): boolean {
  if (value.length > 500) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Null when any header is missing or outside the limits PayPal's schema sets (so junk never reaches PayPal).
export function readWebhookHeaders(headers: Headers): WebhookHeaders | null {
  const authAlgo = headers.get("paypal-auth-algo");
  const certUrl = headers.get("paypal-cert-url");
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionSig = headers.get("paypal-transmission-sig");
  const transmissionTime = headers.get("paypal-transmission-time");
  if (authAlgo === null || certUrl === null || transmissionId === null || transmissionSig === null || transmissionTime === null) return null;
  const valid =
    AUTH_ALGO.test(authAlgo) &&
    httpsUrl(certUrl) &&
    transmissionId.length <= 50 &&
    NO_SPACES.test(transmissionId) &&
    transmissionSig.length <= 500 &&
    NO_SPACES.test(transmissionSig) &&
    transmissionTime.length >= 1 &&
    transmissionTime.length <= 100;
  return valid ? { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime } : null;
}

// The verification request body, built as text: the event goes in exactly as it arrived (PayPal: re-serializing
// can fail verification). `rawEvent` must already have passed JSON.parse as an object.
export function verificationBody(webhookId: string, headers: WebhookHeaders, rawEvent: string): string {
  const fields = JSON.stringify({
    auth_algo: headers.authAlgo,
    cert_url: headers.certUrl,
    transmission_id: headers.transmissionId,
    transmission_sig: headers.transmissionSig,
    transmission_time: headers.transmissionTime,
    webhook_id: webhookId,
  });
  return `${fields.slice(0, -1)},"webhook_event":${rawEvent}}`;
}

export type Verification = "verified" | "unverified";

function verificationStatus(json: unknown): unknown {
  return typeof json === "object" && json !== null && "verification_status" in json ? json.verification_status : undefined;
}

// POST /v1/notifications/verify-webhook-signature (sandbox, Oct 31: a bad signature answers 200 FAILURE).
// 200 SUCCESS → verified; 200 FAILURE, 400, 422 → unverified; 401/403/429/5xx/network → throws PayPalError.
export async function verifyWebhookSignature(client: PayPalClient, webhookId: string, headers: WebhookHeaders, rawEvent: string): Promise<Verification> {
  const res = await client.request({ method: "POST", path: VERIFY, rawBody: verificationBody(webhookId, headers, rawEvent) }, [400, 422]);
  if (res.status === 400 || res.status === 422) {
    console.warn(`PayPal refused to verify a webhook (${res.status}${res.issue ? `, ${res.issue}` : ""}${res.debugId ? `, debug id ${res.debugId}` : ""})`);
    return "unverified";
  }
  const status = verificationStatus(res.json);
  if (status === "SUCCESS") return "verified";
  if (status === "FAILURE") return "unverified";
  // A 2xx without either answer isn't something to act on; PayPal retries the event later.
  throw new PayPalError("unavailable", res.status, "UNEXPECTED_VERIFICATION", res.debugId);
}
