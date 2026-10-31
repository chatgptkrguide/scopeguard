import "server-only";
import { invoiceNumberFor, safePayerViewUrl, type PayPalInvoiceStatus } from "@/domain/invoice";
import { toPayPalValue } from "@/domain/money";
import { PayPalError } from "./errors";
import type { PayPalClient, PayPalResponse } from "./token";

// PayPal Invoicing v2: create, send, read, cancel and search. The 422 issue names read here
// (DUPLICATE_INVOICE_NUMBER, INVOICE_ALREADY_SENT, INVOICE_CANCELED_ALREADY, CANNOT_CANCEL_PAID_INVOICE) are
// not in PayPal's published schema; they were seen in the sandbox (P2 design note §1). Any other 422,
// named or not, is treated as a refusal: nothing is marked sent or cancelled and nothing is created again.

const INVOICES = "/v2/invoicing/invoices";
const SEARCH = "/v2/invoicing/search-invoices";
const INVOICE_ID = /^INV2(-[A-Z0-9]{4}){4}$/; // every id the sandbox returned has this shape
const MAX_ITEM_NAME = 200;

// Not a PayPal name: createInvoice's own issue for a number that is taken by an invoice nobody can pay (cancelled
// in PayPal, or a draft that doesn't match this order). That number can never carry this order's invoice.
export const INVOICE_NUMBER_USED_UP = "INVOICE_NUMBER_USED_UP";
const MAX_NOTE = 4000;

// The client is notified by PayPal (PM decision [2]); the freelancer isn't sent a copy.
const NOTIFY_CLIENT = { send_to_recipient: true, send_to_invoicer: false } as const;

export interface InvoiceInput {
  changeOrderId: string; // source of the reference and the invoice number; also sent as PayPal-Request-Id
  title: string; // item name, cut to 200 characters
  description: string; // item description, e.g. "Estimated 13 h at $50/h"
  note: string; // shown to the client
  amountCents: number; // above zero, from the database
  recipient: { email: string; businessName: string }; // the project's client
}

export interface InvoiceRef {
  id: string;
  invoiceNumber: string;
}

export interface InvoiceView {
  id: string;
  status: PayPalInvoiceStatus;
  invoiceNumber: string | null;
  reference: string | null;
  amountValue: string | null; // "650.00"
  payerViewUrl: string | null; // passed through safePayerViewUrl
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface Money {
  currency_code: "USD";
  value: string;
}

export interface InvoiceBody {
  detail: { currency_code: "USD"; invoice_number: string; reference: string; note: string; payment_term: { term_type: "DUE_ON_RECEIPT" } };
  primary_recipients: [{ billing_info: { business_name: string; email_address: string } }];
  items: [{ name: string; description: string; quantity: "1"; unit_amount: Money }];
}

// The request body. No invoicer: PayPal fills it from the account profile and refuses one in some setups.
export function invoiceBody(input: InvoiceInput): InvoiceBody {
  if (!(Number.isInteger(input.amountCents) && input.amountCents > 0)) throw new RangeError("an invoice needs an amount above zero");
  return {
    detail: {
      currency_code: "USD",
      invoice_number: invoiceNumberFor(input.changeOrderId),
      reference: input.changeOrderId,
      note: clip(input.note, MAX_NOTE),
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    },
    primary_recipients: [{ billing_info: { business_name: input.recipient.businessName, email_address: input.recipient.email } }],
    items: [
      {
        name: clip(input.title, MAX_ITEM_NAME),
        description: input.description,
        quantity: "1",
        // Always two decimals: PayPal silently cuts a third one.
        unit_amount: { currency_code: "USD", value: toPayPalValue(input.amountCents) },
      },
    ],
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function invoicePath(invoiceId: string, action = ""): string {
  // The id comes from our database, but it still goes into a URL, so only PayPal's shape is allowed.
  if (!INVOICE_ID.test(invoiceId)) throw new PayPalError("rejected", null, "INVALID_INVOICE_ID", null);
  return `${INVOICES}/${invoiceId}${action}`;
}

function refused(res: PayPalResponse): PayPalError {
  return new PayPalError("rejected", res.status, res.issue, res.debugId);
}

// An invoice as PayPal returns it from GET, search or create (with Prefer: return=representation).
function toView(json: unknown, environment: PayPalClient["environment"]): InvoiceView {
  const id = field(json, "id");
  const status = field(json, "status");
  if (typeof id !== "string" || !INVOICE_ID.test(id) || typeof status !== "string") {
    throw new PayPalError("unavailable", null, "UNEXPECTED_INVOICE", null);
  }
  const detail = field(json, "detail");
  return {
    id,
    status,
    invoiceNumber: text(field(detail, "invoice_number")),
    reference: text(field(detail, "reference")),
    amountValue: text(field(field(json, "amount"), "value")),
    payerViewUrl: safePayerViewUrl(field(field(detail, "metadata"), "recipient_view_url"), environment),
  };
}

async function search(client: PayPalClient, criteria: Readonly<Record<string, string>>): Promise<InvoiceView[]> {
  const res = await client.request({ method: "POST", path: SEARCH, body: criteria });
  const items = field(res.json, "items");
  return Array.isArray(items) ? items.map((item) => toView(item, client.environment)) : [];
}

// POST /v2/invoicing/invoices. PayPal-Request-Id is sent but Invoicing ignores it (sandbox, Oct 31, 2026);
// the invoice number is what stops a second invoice. When PayPal says the number exists, the invoice made by an
// earlier try is looked up and reused, but only if it belongs to this change order, has the same amount, and
// isn't cancelled. A search that finds nothing yet (PayPal's index can lag) counts as unavailable: the next
// try finds it. A cancelled invoice, or a draft that doesn't match, uses the number up for good
// (INVOICE_NUMBER_USED_UP, P2-D4); a payable one that doesn't match is refused as before and left alone.
export async function createInvoice(client: PayPalClient, input: InvoiceInput): Promise<InvoiceRef & { created: boolean }> {
  const body = invoiceBody(input);
  const invoiceNumber = body.detail.invoice_number;
  const res = await client.request(
    {
      method: "POST",
      path: INVOICES,
      body,
      headers: { Prefer: "return=representation", "PayPal-Request-Id": input.changeOrderId },
    },
    [422],
  );

  if (res.status === 422) {
    if (res.issue !== "DUPLICATE_INVOICE_NUMBER") throw refused(res);
    const existing = await findByInvoiceNumber(client, invoiceNumber);
    if (!existing) throw new PayPalError("unavailable", 422, "DUPLICATE_INVOICE_NUMBER", res.debugId);
    const sameOrder = existing.reference === input.changeOrderId && existing.amountValue === toPayPalValue(input.amountCents);
    if (sameOrder && existing.status !== "CANCELLED") return { id: existing.id, invoiceNumber, created: false };
    if (existing.status === "CANCELLED" || existing.status === "DRAFT") {
      throw new PayPalError("rejected", 422, INVOICE_NUMBER_USED_UP, res.debugId);
    }
    throw refused(res);
  }

  // Prefer: return=representation answers with the whole invoice; without it, only a self link comes back.
  const fromBody = field(res.json, "id");
  const links = field(res.json, "links");
  const self = Array.isArray(links) ? text(field(links.find((l) => field(l, "rel") === "self"), "href")) : null;
  const id = typeof fromBody === "string" ? fromBody : self?.split("/").pop();
  if (typeof id !== "string" || !INVOICE_ID.test(id)) throw new PayPalError("unavailable", res.status, "UNEXPECTED_INVOICE", res.debugId);
  return { id, invoiceNumber, created: true };
}

// POST .../{id}/send. A second send answers INVOICE_ALREADY_SENT, which counts as sent.
// 202 means PayPal scheduled it for a later date, which the app never asks for, so it is refused.
export async function sendInvoice(client: PayPalClient, invoiceId: string): Promise<"sent" | "already_sent"> {
  const res = await client.request({ method: "POST", path: invoicePath(invoiceId, "/send"), body: NOTIFY_CLIENT }, [422]);
  if (res.status === 422) {
    if (res.issue === "INVOICE_ALREADY_SENT") return "already_sent";
    throw refused(res);
  }
  if (res.status === 202) throw new PayPalError("rejected", 202, "SCHEDULED", res.debugId);
  return "sent";
}

// GET .../{id}
export async function getInvoice(client: PayPalClient, invoiceId: string): Promise<InvoiceView> {
  const res = await client.request({ method: "GET", path: invoicePath(invoiceId) });
  return toView(res.json, client.environment);
}

// POST .../{id}/cancel. Cancelling twice answers INVOICE_CANCELED_ALREADY, which counts as cancelled.
// A paid invoice can't be cancelled; that is reported, not thrown, so the caller can say so.
export async function cancelInvoice(client: PayPalClient, invoiceId: string): Promise<"cancelled" | "already_cancelled" | "paid"> {
  const res = await client.request({ method: "POST", path: invoicePath(invoiceId, "/cancel"), body: NOTIFY_CLIENT }, [422]);
  if (res.status === 422) {
    if (res.issue === "INVOICE_CANCELED_ALREADY") return "already_cancelled";
    if (res.issue === "CANNOT_CANCEL_PAID_INVOICE") return "paid";
    throw refused(res);
  }
  return "cancelled";
}

// The invoice with exactly this number, or null.
export async function findByInvoiceNumber(client: PayPalClient, invoiceNumber: string): Promise<InvoiceView | null> {
  const found = await search(client, { invoice_number: invoiceNumber });
  return found.find((invoice) => invoice.invoiceNumber === invoiceNumber) ?? null;
}

// Every invoice whose reference is exactly this one. PayPal's reference search also matches prefixes,
// so the results are filtered again. Used by the acceptance tests to count invoices per change order.
export async function invoicesForReference(client: PayPalClient, reference: string): Promise<InvoiceView[]> {
  const found = await search(client, { reference });
  return found.filter((invoice) => invoice.reference === reference);
}
