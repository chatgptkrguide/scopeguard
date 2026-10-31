// PayPal sandbox answers for unit tests, trimmed from the calls recorded in the P2 design note (Oct 31, 2026,
// api-m.sandbox.paypal.com). Ids, numbers, links and issue names are the ones PayPal returned; tokens are
// stand-ins and debug ids are made up. The client is the fictional demo client.

export const CHANGE_ORDER_ID = "0244f9b8-b8ac-4e6b-b86d-f3d648c071e0";
export const INVOICE_ID = "INV2-DZQM-QREH-7LAT-F7YR";
export const INVOICE_NUMBER = "TG-4ILUBN7LCCN6SKDSN5C15S";
export const PAYER_VIEW_URL = "https://www.sandbox.paypal.com/invoice/p/#DZQMQREH7LATF7YR";
export const SEND_HREF = "https://www.sandbox.paypal.com/invoice/p/#INV2-DZQM-QREH-7LAT-F7YR";

export const tokenResponse = (accessToken: string, expiresIn = 32400) => ({
  scope: "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/payments/payment",
  access_token: accessToken,
  token_type: "Bearer",
  app_id: "APP-STANDIN00000000000",
  expires_in: expiresIn,
  nonce: "2026-10-31T02:10:20Zstand-in-nonce",
});

export const invalidClient = { error: "invalid_client", error_description: "Client Authentication failed" };

// Two 401 shapes: OAuth's for an unknown token, REST's for a missing header.
export const invalidToken = { error: "invalid_token", error_description: "The token passed in was not found in the system" };
export const authenticationFailure = {
  name: "AUTHENTICATION_FAILURE",
  message: "Authentication failed due to invalid authentication credentials or a missing Authorization header.",
  links: [{ href: "https://developer.paypal.com/docs/api/overview/#error", rel: "information_link" }],
};

function invoice(status: string, metadata: Record<string, string>) {
  return {
    id: INVOICE_ID,
    status,
    detail: {
      reference: CHANGE_ORDER_ID,
      currency_code: "USD",
      note: "Change order for Online ordering site. Not part of the agreed scope.",
      invoice_number: INVOICE_NUMBER,
      invoice_date: "2026-10-30",
      payment_term: { term_type: "DUE_ON_RECEIPT" },
      metadata: { create_time: "2026-10-31T02:17:27Z", recipient_view_url: PAYER_VIEW_URL, invoicer_view_url: "https://www.sandbox.paypal.com/invoice/details/INV2-DZQM-QREH-7LAT-F7YR", ...metadata },
    },
    invoicer: {},
    primary_recipients: [{ billing_info: { business_name: "Harbor & Pine Coffee", email_address: "maya@harborandpine.example" } }],
    items: [
      {
        id: "ITEM-1AB23456CD789012E",
        name: "Loyalty page with customer login",
        description: "Estimated 13 h at $50/h, rounded up to the next $10",
        quantity: "1",
        unit_amount: { currency_code: "USD", value: "650.00" },
        unit_of_measure: "QUANTITY",
      },
    ],
    amount: { currency_code: "USD", value: "650.00", breakdown: { item_total: { currency_code: "USD", value: "650.00" } } },
    due_amount: { currency_code: "USD", value: "650.00" },
    links: [{ href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${INVOICE_ID}`, rel: "self", method: "GET" }],
  };
}

// POST /v2/invoicing/invoices with Prefer: return=representation → 201
export const createdDraft = invoice("DRAFT", {});
// GET /v2/invoicing/invoices/{id}
export const sentInvoice = invoice("SENT", { first_sent_time: "2026-10-31T02:17:30Z", last_sent_time: "2026-10-31T02:17:30Z" });
export const cancelledInvoice = invoice("CANCELLED", { first_sent_time: "2026-10-31T02:17:30Z", cancel_time: "2026-10-31T02:18:02Z" });

// POST /v2/invoicing/search-invoices → 200
export const searchResult = (...items: object[]) => ({ total_items: items.length, total_pages: 1, items });

// POST .../send → 200
export const sendResponse = { href: SEND_HREF, rel: "payer-view", method: "GET" };

function unprocessable(issue: string, description: string, fieldName: string) {
  return {
    name: "UNPROCESSABLE_ENTITY",
    message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
    debug_id: "f5a1c27e3b9d4",
    details: [{ field: fieldName, value: "", location: "body", issue, description }],
    links: [{ href: "https://developer.paypal.com/docs/api/invoicing/#errors", method: "GET", rel: "information_link" }],
  };
}

export const duplicateInvoiceNumber = unprocessable("DUPLICATE_INVOICE_NUMBER", "Invoice number already exists.", "/detail/invoice_number");
export const invoiceAlreadySent = unprocessable("INVOICE_ALREADY_SENT", "The invoice is already sent.", "invoiceId");
export const cannotSendInvoice = unprocessable("CANNOT_SEND_INVOICE", "Only DRAFT and UNPAID invoices can be sent.", "invoiceId");
export const invoiceCanceledAlready = unprocessable("INVOICE_CANCELED_ALREADY", "Invoice is already cancelled.", "invoiceId");
export const cannotCancelPaidInvoice = unprocessable("CANNOT_CANCEL_PAID_INVOICE", "Cannot cancel a paid or partially paid invoice.", "invoiceId");
export const cannotCancelDraftInvoice = unprocessable("CANNOT_CANCEL_DRAFT_INVOICE", "Draft invoice cannot be canceled.", "invoiceId");

export const invalidRequest = {
  name: "INVALID_REQUEST",
  message: "Request is not well-formed, syntactically incorrect, or violates schema.",
  debug_id: "c8e0b4f1a2d37",
  details: [{ field: "/items/0/unit_amount/value", value: "abc", location: "body", issue: "INVALID_PARAMETER_SYNTAX", description: "The value of a field does not conform to the expected format." }],
};

export const totalAmountNegative = {
  name: "MEDIA_TYPE_NOT_ACCEPTABLE",
  message: "The requested media type is not acceptable.",
  debug_id: "a91d3e57c0b28",
  details: [{ issue: "TOTAL_AMOUNT_NEGATIVE", description: "Total amount cannot be negative." }],
};

export const resourceNotFound = {
  name: "RESOURCE_NOT_FOUND",
  message: "The specified resource does not exist.",
  debug_id: "b2e6f80d4c1a9",
  details: [],
};

export const internalServerError = { name: "INTERNAL_SERVER_ERROR", debug_id: "d07c9a1e6b3f5", message: "An internal server error has occurred." };

// A stand-in for fetch that answers by "METHOD /path" and records each call. A list of replies is used in
// order and its last reply repeats. "network-error" throws like a dropped connection; "hang" never answers,
// so only the request's timeout signal ends it.
export type FakeReply = { status: number; body?: unknown } | "network-error" | "hang";

export interface FakeCall {
  method: string;
  path: string; // pathname + search
  url: string;
  headers: Record<string, string>; // lower-case names
  body: string | undefined;
}

export function fakeFetch(script: Readonly<Record<string, FakeReply | readonly FakeReply[]>>) {
  const calls: FakeCall[] = [];
  const used = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const call: FakeCall = {
      method: init?.method ?? "GET",
      path: parsed.pathname + parsed.search,
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${parsed.pathname}`;
    const entry = script[key] ?? (key === "POST /v1/oauth2/token" ? { status: 200, body: tokenResponse("A21A-stand-in-token-1") } : undefined);
    if (entry === undefined) throw new Error(`fakeFetch: no reply for ${key}`);
    const list: readonly FakeReply[] = Array.isArray(entry) ? entry : [entry as FakeReply];
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const reply = list[Math.min(n, list.length - 1)];
    if (reply === "network-error") throw new TypeError("fetch failed");
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    const body = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status, headers: { "paypal-debug-id": "hdr7debug2id" } });
  };
  return { fetch, calls, to: (key: string) => calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key) };
}
