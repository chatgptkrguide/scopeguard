import "server-only";
import type { BatchItem } from "drizzle-orm/batch";
import { paymentDecision, paymentPrecheck } from "@/domain/payment";
import { INVOICE_PAID_EVENT, type WebhookOutcome } from "@/domain/webhook";
import { invoiceGateway, type InvoiceGateway } from "./billing";
import { findOrderByInvoiceId } from "./db/change-orders";
import { getDb, type Db } from "./db/client";
import { isUniqueViolation } from "./db/errors";
import { hasWebhookEvent, insertWebhookEvent, type WebhookEventRow } from "./db/webhook-events";
import { env } from "./env";
import { settleStatements } from "./payments";
import { PayPalError } from "./paypal/errors";
import { isPayPalInvoiceId, type InvoiceView } from "./paypal/invoices";
import { getPayPal } from "./paypal/token";
import { MAX_WEBHOOK_BYTES, readWebhookHeaders, verifyWebhookSignature, type Verification, type WebhookHeaders } from "./paypal/webhooks";

// POST /api/webhooks/paypal. The answer's status code tells PayPal whether to try again (it retries any non-2xx for
// three days): 5xx when a retry could help (no webhook id yet, PayPal or the database unavailable, an event we
// couldn't read), 200 when it can't (duplicates, unknown invoices, unpaid invoices, other event types), 400 for
// forged or malformed requests, 413 past 64 KB. Nothing is written and no invoice is read before PayPal confirms the
// signature. Only the invoice id is taken from the event; the status, reference, amount and currency come from PayPal.
// Logs carry the event id, type, outcome and PayPal's issue and debug id: never the body, a header or an email.

export interface WebhookVerifier {
  verify(webhookId: string, headers: WebhookHeaders, rawEvent: string): Promise<Verification>;
}

export interface WebhookDeps {
  db: Db;
  paypal: InvoiceGateway | null; // reads the invoice back (billing.ts)
  verifier: WebhookVerifier | null; // null: no PayPal keys on this server
  webhookId: string | null; // PAYPAL_WEBHOOK_ID
  now: () => Date;
  verifyLimit?: VerifyLimit; // server-wide cap on verification calls (PM decision [D8])
}

export interface VerifyLimit {
  max: number; // calls allowed per window (60 a minute, PM decision [D8])
  windowMs: number;
  times: number[]; // this process only; a restart forgets it, which is fine for a flood guard
}

export type WebhookReply =
  | { status: 200; outcome: WebhookOutcome | "duplicate" }
  | { status: 400; outcome: "bad_request" | "unverified" }
  | { status: 413; outcome: "too_large" }
  | { status: 500; outcome: "no_invoice_id" | "server_error" }
  | { status: 503; outcome: "not_configured" | "verify_unavailable" | "invoice_unavailable" | "busy"; retryAfterSeconds?: number };

const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_EVENT_TYPE = 100;
const BUSY_RETRY_SECONDS = 60;

// Reads at most maxBytes from the stream and stops reading past it (a missing or false Content-Length can't
// get around it). Bytes are decoded as strict UTF-8 (TextDecoder fatal), with a byte order mark kept as it came.
export async function readBodyWithin(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; outcome: "too_large" | "bad_request" }> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, outcome: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, outcome: "bad_request" };
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

// The invoice id a PAID event is about: resource.invoice.id or resource.id, whichever has PayPal's INV2 shape.
// Both shapes are read because the real sandbox payload isn't confirmed yet (design note §1.2).
export function invoiceIdFromEvent(event: unknown): string | null {
  const resource = field(event, "resource");
  const nested = field(field(resource, "invoice"), "id");
  if (isPayPalInvoiceId(nested)) return nested;
  const direct = field(resource, "id");
  return isPayPalInvoiceId(direct) ? direct : null;
}

interface EventHead {
  id: string;
  type: string;
  createdAt: string | null; // create_time, only if it reads as a time
}

function eventHead(event: unknown): EventHead | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return null;
  const id = field(event, "id");
  const type = field(event, "event_type");
  if (typeof id !== "string" || !EVENT_ID.test(id) || typeof type !== "string" || type === "" || type.length > MAX_EVENT_TYPE) return null;
  const created = field(event, "create_time");
  const createdAt = typeof created === "string" && created.length <= 40 && !Number.isNaN(Date.parse(created)) ? created : null;
  return { id, type, createdAt };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Takes one verification call if the window still has room. Never awaits, so two requests can't both take the last.
function takeVerifyCall(limit: VerifyLimit, nowMs: number): boolean {
  limit.times = limit.times.filter((time) => time > nowMs - limit.windowMs);
  if (limit.times.length >= limit.max) return false;
  limit.times.push(nowMs);
  return true;
}

function lagText(head: EventHead, receivedAt: Date): string {
  if (head.createdAt === null) return "lag unknown";
  return `lag ${Math.round((receivedAt.getTime() - Date.parse(head.createdAt)) / 1000)}s`;
}

export async function receivePayPalWebhook(deps: WebhookDeps, request: Request): Promise<WebhookReply> {
  const { db, paypal, verifier, webhookId, now } = deps;

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_WEBHOOK_BYTES) return { status: 413, outcome: "too_large" };
  if (!webhookId || !verifier || !paypal) return { status: 503, outcome: "not_configured" };

  const headers = readWebhookHeaders(request.headers);
  if (!headers) return { status: 400, outcome: "bad_request" };
  const body = await readBodyWithin(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) return body.outcome === "too_large" ? { status: 413, outcome: "too_large" } : { status: 400, outcome: "bad_request" };
  const event = parseJson(body.text);
  const head = eventHead(event);
  if (!head) return { status: 400, outcome: "bad_request" };

  const receivedAt = now();
  if (deps.verifyLimit && !takeVerifyCall(deps.verifyLimit, receivedAt.getTime())) {
    console.warn(`paypal webhook ${head.id}: verification calls are over the per-minute cap; PayPal will retry`);
    return { status: 503, outcome: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };
  }

  try {
    if ((await verifier.verify(webhookId, headers, body.text)) !== "verified") {
      console.warn(`paypal webhook ${head.id}: PayPal didn't confirm the signature`);
      return { status: 400, outcome: "unverified" };
    }
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    if (error.failure === "auth") console.error(`paypal webhook ${head.id}: PayPal refused the app's credentials while verifying a webhook`, error);
    else console.error(`paypal webhook ${head.id}: verifying the signature failed`, error);
    return { status: 503, outcome: "verify_unavailable" };
  }

  // Verified from here on.
  const at = receivedAt.toISOString();
  const log = (outcome: WebhookOutcome | "duplicate") => console.log(`paypal webhook ${head.id} ${head.type} → ${outcome} (${lagText(head, receivedAt)})`);
  const row = (outcome: WebhookOutcome, invoiceId: string | null): WebhookEventRow => ({
    id: head.id,
    eventType: head.type,
    invoiceId,
    outcome,
    eventCreatedAt: head.createdAt,
    receivedAt: at,
  });

  try {
    // Records the event (with the change it causes) in one batch; a second record of the same event rolls back whole.
    const record = async (outcome: WebhookOutcome, invoiceId: string | null, change: BatchItem<"sqlite">[] = []): Promise<WebhookReply> => {
      try {
        await db.batch([insertWebhookEvent(db, row(outcome, invoiceId)), ...change]);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        log("duplicate");
        return { status: 200, outcome: "duplicate" };
      }
      log(outcome);
      return { status: 200, outcome };
    };

    if (head.type !== INVOICE_PAID_EVENT) return await record("ignored_type", null);

    const invoiceId = invoiceIdFromEvent(event);
    if (!invoiceId) {
      // Our reading of the event is wrong: leave it unrecorded so PayPal sends it again once that is fixed.
      console.error(`paypal webhook ${head.id}: no invoice id in a paid event`);
      return { status: 500, outcome: "no_invoice_id" };
    }
    if (await hasWebhookEvent(db, head.id)) {
      log("duplicate");
      return { status: 200, outcome: "duplicate" };
    }

    const order = await findOrderByInvoiceId(db, invoiceId);
    if (!order) return await record("unknown_invoice", invoiceId);
    const precheck = paymentPrecheck(order);
    if (precheck === "already_paid") return await record("already_paid", invoiceId);
    if (precheck !== "read") {
      console.warn(`paypal webhook ${head.id}: invoice ${invoiceId} belongs to a ${order.status} change order`);
      return await record("order_closed", invoiceId);
    }

    let invoice: InvoiceView;
    try {
      invoice = await paypal.get(invoiceId);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      console.error(`paypal webhook ${head.id}: reading invoice ${invoiceId} failed`, error);
      return { status: 503, outcome: "invoice_unavailable" };
    }

    const decision = paymentDecision(order, invoice);
    if (decision.kind === "mismatch") {
      console.error(`paypal webhook ${head.id}: invoice ${invoiceId} doesn't match its change order's reference, amount or currency; not marked paid`);
      return await record("mismatch", invoiceId);
    }
    if (decision.kind === "not_settled") return await record("not_settled", invoiceId);
    return await record("settled", invoiceId, settleStatements(db, order, invoice, decision, at, "webhook", head.id));
  } catch (error) {
    // The database failed: nothing was recorded, so PayPal's retry is handled.
    console.error(`paypal webhook ${head.id}: handling failed`, error);
    return { status: 500, outcome: "server_error" };
  }
}

// Lives as long as the server process.
const serverVerifyLimit: VerifyLimit = { max: 60, windowMs: 60 * 1000, times: [] };

export function liveWebhookDeps(): WebhookDeps {
  const client = getPayPal();
  return {
    db: getDb(),
    paypal: client && invoiceGateway(client),
    verifier: client && { verify: (webhookId, headers, rawEvent) => verifyWebhookSignature(client, webhookId, headers, rawEvent) },
    webhookId: env().PAYPAL_WEBHOOK_ID ?? null,
    now: () => new Date(),
    verifyLimit: serverVerifyLimit,
  };
}
