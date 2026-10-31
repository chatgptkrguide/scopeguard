// PayPal invoice rules that need no I/O: the invoice number, which payer links are kept, which statuses count as sent.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE36_DIGITS = 25; // 36^25 > 2^128, so a whole UUID fits
const KEPT_DIGITS = 22; // PayPal allows 25 characters: "TG-" + 22

// The invoice number is how PayPal keeps one invoice per change order: it refuses a second invoice with the
// same number, even when two requests arrive at once (PayPal-Request-Id is ignored by Invoicing, D-018).
// The UUID's 128 bits in upper-case base 36, last 22 digits (about 113 bits): the same id always gives the
// same number, and with no lower-case digits, a comparison that ignores case can't make two numbers collide.
// 0244f9b8-b8ac-4e6b-b86d-f3d648c071e0 → TG-4ILUBN7LCCN6SKDSN5C15S (the number used in the sandbox).
export function invoiceNumberFor(changeOrderId: string): string {
  if (!UUID.test(changeOrderId)) throw new RangeError("a change order id must be a UUID");
  const digits = BigInt(`0x${changeOrderId.replaceAll("-", "")}`)
    .toString(36)
    .toUpperCase()
    .padStart(BASE36_DIGITS, "0");
  return `TG-${digits.slice(-KEPT_DIGITS)}`;
}

const SANDBOX_HOST = "www.sandbox.paypal.com";
const PAYER_VIEW_PATH = "/invoice/p/";
// The invoice token PayPal puts after the #: "DZQMQREH7LATF7YR" or "INV2-3XAZ-YS6T-5QRP-FPYQ" in the sandbox.
const PAYER_VIEW_TOKEN = /^#[A-Za-z0-9-]{1,64}$/;
const MAX_URL_LENGTH = 2048;

// The client's PayPal page, only if it is exactly a sandbox payer link: https://www.sandbox.paypal.com/invoice/p/#<token>.
// The link is parsed rather than matched as text, and kept only if parsing gives back the same string, so dot
// segments (/invoice/p/../../x), encoded dots, a port, user info, a query or stray characters can't reach an
// <a href> (P2-S2). The live link format isn't confirmed yet, so live links are not kept (P2 is sandbox only).
export function safePayerViewUrl(url: unknown, environment: "sandbox" | "live"): string | null {
  if (environment !== "sandbox" || typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const exact =
    parsed.href === url &&
    parsed.protocol === "https:" &&
    parsed.host === SANDBOX_HOST &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === PAYER_VIEW_PATH &&
    parsed.search === "" &&
    PAYER_VIEW_TOKEN.test(parsed.hash);
  return exact ? url : null;
}

// PayPal's invoice status: 16 known values, but an unknown one is kept as text rather than refused.
export type PayPalInvoiceStatus = string;

// Statuses that mean the invoice went out to the client, so the change order may be marked sent.
export const SENT_LIKE: ReadonlySet<PayPalInvoiceStatus> = new Set([
  "SENT",
  "UNPAID",
  "PAYMENT_PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "MARKED_AS_PAID",
  "SHARED",
]);

// Paid in full: the client paid (PAID) or the freelancer recorded the whole payment in PayPal (MARKED_AS_PAID, PM
// decision [D1]). Only these move a change order to paid.
export const SETTLED: ReadonlySet<PayPalInvoiceStatus> = new Set(["PAID", "MARKED_AS_PAID"]);

// Money is moving but the invoice isn't paid in full yet: the order stays sent. PayPal sends its "paid" webhook for
// these too ("paid, partially paid, or payment is made and is pending").
export const PAYMENT_UNDER_WAY: ReadonlySet<PayPalInvoiceStatus> = new Set(["PARTIALLY_PAID", "PAYMENT_PENDING"]);

// The only currency the app invoices in (invoices.ts makes every invoice in USD).
export const INVOICE_CURRENCY = "USD";
