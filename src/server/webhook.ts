import "server-only";
import type { BatchItem } from "drizzle-orm/batch";
import { paymentDecision, paymentPrecheck } from "@/domain/payment";
import { INVOICE_PAID_EVENT, type WebhookOutcome } from "@/domain/webhook";
import { invoiceGateway, type InvoiceGateway } from "./billing";
import { findOrderByInvoiceId, ownedStatus } from "./db/change-orders";
import { getDb, type Db } from "./db/client";
import { isUniqueViolation } from "./db/errors";
import { hasWebhookEvent, insertWebhookEvent, setWebhookOutcome, type WebhookEventRow } from "./db/webhook-events";
import { env } from "./env";
import { settleStatements } from "./payments";
import { PayPalError } from "./paypal/errors";
import { isPayPalInvoiceId, type InvoiceView } from "./paypal/invoices";
import { getPayPal } from "./paypal/token";
import { MAX_WEBHOOK_BYTES, readWebhookHeaders, verifyWebhookSignature, type Verification, type WebhookHeaders } from "./paypal/webhooks";

// POST /api/webhooks/paypal. The answer's status code tells PayPal whether to try again (it retries any non-2xx for
// three days): 5xx when a retry could help (no webhook id yet, PayPal or the database unavailable, an event we
// couldn't read, an invoice PayPal doesn't show as paid yet), 200 when it can't (duplicates, unknown invoices, partly
// paid or cancelled invoices, other event types), 400 for forged or malformed requests, 408 for a body that takes
// longer than 10 seconds, 413 past 64 KB. Nothing is written and no invoice is read before PayPal confirms the
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
  senderLimit?: SenderLimit; // cap per sender, before the body is read (P3-S1)
  verifyLimit?: VerifyLimit; // server-wide cap on verification calls (PM decision [D8])
}

// Two caps, so one sender's flood of forged requests can't hold off PayPal's real ones (P3-S1): each sender gets a
// few requests a minute before anything else is done, and all senders together get the server-wide verification
// cap, which is higher, to keep PayPal's own rate limit for the app's sends.
export interface SenderLimit {
  max: number; // requests one sender may make per window (20 a minute)
  windowMs: number;
  senders: Map<string, number[]>; // sender → request times; this process only, like VerifyLimit
}

export interface VerifyLimit {
  max: number; // calls allowed per window (60 a minute, PM decision [D8])
  windowMs: number;
  times: number[]; // this process only; a restart forgets it, which is fine for a flood guard
}

export type WebhookReply =
  | { status: 200; outcome: WebhookOutcome | "duplicate" }
  | { status: 400; outcome: "bad_request" | "unverified" }
  | { status: 408; outcome: "body_timeout" }
  | { status: 413; outcome: "too_large" }
  | { status: 500; outcome: "no_invoice_id" | "server_error" }
  | {
      status: 503;
      outcome: "not_configured" | "verify_unavailable" | "invoice_unavailable" | "busy" | "payment_awaited";
      retryAfterSeconds?: number;
    };

const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_EVENT_TYPE = 100;
const RETRY_AFTER_SECONDS = 60;
// The whole body must arrive within this, so a slow sender can't hold a connection (P3-S3). PayPal's events are a
// few kilobytes; a real one cut off here is sent again.
export const BODY_TIMEOUT_MS = 10_000;
// Past this many senders in one window, new senders wait for the window to empty: memory stays bounded.
const MAX_TRACKED_SENDERS = 10_000;

export type BodyRead = { ok: true; text: string } | { ok: false; outcome: "too_large" | "bad_request" | "timeout" };

// Reads at most maxBytes from the stream and stops reading past it (a missing or false Content-Length can't
// get around it), or once timeoutMs has passed since it started. Bytes are decoded as strict UTF-8 (TextDecoder
// fatal), with a byte order mark kept as it came.
export async function readBodyWithin(request: Request, maxBytes: number, timeoutMs = BODY_TIMEOUT_MS): Promise<BodyRead> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next === "timeout") {
        // Not awaited: a stalled sender may never let the cancel finish.
        reader.cancel().catch(() => {});
        return { ok: false, outcome: "timeout" };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, outcome: "too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
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

const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

// Who sent the request, for the per-sender cap. On Render, public traffic comes through Cloudflare, which sets
// CF-Connecting-IP on every request to a web service and overwrites any value the caller sent; it appends to
// X-Forwarded-For instead, so that header's first entry is whatever the caller wrote
// (https://render.com/articles/host-pocketbase-on-render; Render's DDoS guide says to read the client IP from
// x-forwarded-for: https://render.com/articles/how-render-handles-ddos-attacks). So CF-Connecting-IP comes first and
// the first X-Forwarded-For entry is only a fallback. Unconfirmed on our own service until the first deploy: check
// that CF-Connecting-IP arrives. With neither header (a local run), every request shares one sender.
export function senderOf(headers: Headers): string {
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare && IP_TEXT.test(cloudflare)) return cloudflare;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && IP_TEXT.test(forwarded) ? forwarded : "unknown";
}

// Takes one request for this sender if its window still has room. Never awaits, like takeVerifyCall.
function takeSenderCall(limit: SenderLimit, sender: string, nowMs: number): boolean {
  const since = nowMs - limit.windowMs;
  if (!limit.senders.has(sender) && limit.senders.size >= MAX_TRACKED_SENDERS) {
    for (const [key, times] of limit.senders) if ((times.at(-1) ?? 0) <= since) limit.senders.delete(key);
    if (limit.senders.size >= MAX_TRACKED_SENDERS) return false;
  }
  const times = (limit.senders.get(sender) ?? []).filter((time) => time > since);
  const room = times.length < limit.max;
  if (room) times.push(nowMs);
  limit.senders.set(sender, times);
  return room;
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
  const receivedAt = now();
  if (deps.senderLimit && !takeSenderCall(deps.senderLimit, senderOf(request.headers), receivedAt.getTime())) {
    console.warn("paypal webhook: one sender is over its per-minute cap; PayPal will retry");
    return { status: 503, outcome: "busy", retryAfterSeconds: RETRY_AFTER_SECONDS };
  }
  const body = await readBodyWithin(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) {
    if (body.outcome === "timeout") return { status: 408, outcome: "body_timeout" };
    return body.outcome === "too_large" ? { status: 413, outcome: "too_large" } : { status: 400, outcome: "bad_request" };
  }
  const event = parseJson(body.text);
  const head = eventHead(event);
  if (!head) return { status: 400, outcome: "bad_request" };

  if (deps.verifyLimit && !takeVerifyCall(deps.verifyLimit, receivedAt.getTime())) {
    console.warn(`paypal webhook ${head.id}: verification calls are over the per-minute cap; PayPal will retry`);
    return { status: 503, outcome: "busy", retryAfterSeconds: RETRY_AFTER_SECONDS };
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

  const answer = (outcome: WebhookOutcome | "duplicate"): WebhookReply => {
    log(outcome);
    return { status: 200, outcome };
  };

  try {
    // Records the event (with the change it causes) in one batch; a second record of the same event rolls back whole.
    // False when the event was recorded already (a duplicate).
    const recorded = async (outcome: WebhookOutcome, invoiceId: string | null, change: BatchItem<"sqlite">[] = []): Promise<boolean> => {
      try {
        await db.batch([insertWebhookEvent(db, row(outcome, invoiceId)), ...change]);
        return true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return false;
      }
    };
    const record = async (outcome: WebhookOutcome, invoiceId: string | null): Promise<WebhookReply> =>
      answer((await recorded(outcome, invoiceId)) ? outcome : "duplicate");

    if (head.type !== INVOICE_PAID_EVENT) return await record("ignored_type", null);

    const invoiceId = invoiceIdFromEvent(event);
    if (!invoiceId) {
      // Our reading of the event is wrong: leave it unrecorded so PayPal sends it again once that is fixed.
      console.error(`paypal webhook ${head.id}: no invoice id in a paid event`);
      return { status: 500, outcome: "no_invoice_id" };
    }
    if (await hasWebhookEvent(db, head.id)) return answer("duplicate");

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
    if (decision.kind === "not_settled") {
      if (!decision.awaited) return await record("not_settled", invoiceId);
      // PayPal hasn't caught up with its own event, or the payment is pending: leave the event unrecorded so PayPal
      // sends it again, and the order settles on a later try (P3-S2). After PayPal's three days of retries, "Check
      // payment" is what is left.
      console.warn(`paypal webhook ${head.id}: invoice ${invoiceId} reads ${invoice.status}, not paid in full yet; PayPal will retry`);
      return { status: 503, outcome: "payment_awaited", retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    if (!(await recorded("settled", invoiceId, settleStatements(db, order, invoice, decision, at, "webhook", head.id)))) return answer("duplicate");
    return answer(await settledOutcome(db, head.id, invoiceId, order));
  } catch (error) {
    // The database failed: nothing was recorded, so PayPal's retry is handled.
    console.error(`paypal webhook ${head.id}: handling failed`, error);
    return { status: 500, outcome: "server_error" };
  }
}

// After a settling batch: the order is paid, by this batch or by "Check payment" a moment before. If it isn't, the
// UPDATE found the order no longer sent or draft (a cancel won the race, P3-D1): PayPal has the money but the order
// isn't paid, so the event's outcome says so and a warning is logged (P3-C2). The event is recorded either way, so a
// failure here is logged and answered as settled rather than retried.
async function settledOutcome(db: Db, eventId: string, invoiceId: string, order: { id: string; projectId: string }): Promise<WebhookOutcome> {
  try {
    const status = await ownedStatus(db, order.projectId, order.id);
    if (status === "paid") return "settled";
    console.warn(`paypal webhook ${eventId}: PayPal shows invoice ${invoiceId} paid, but its change order is ${status ?? "gone"}; not marked paid`);
    await setWebhookOutcome(db, eventId, "paid_not_applied");
    return "paid_not_applied";
  } catch (error) {
    console.error(`paypal webhook ${eventId}: checking the settled change order failed`, error);
    return "settled";
  }
}

// Live as long as the server process.
const serverSenderLimit: SenderLimit = { max: 20, windowMs: 60 * 1000, senders: new Map() };
const serverVerifyLimit: VerifyLimit = { max: 60, windowMs: 60 * 1000, times: [] };

export function liveWebhookDeps(): WebhookDeps {
  const client = getPayPal();
  return {
    db: getDb(),
    paypal: client && invoiceGateway(client),
    verifier: client && { verify: (webhookId, headers, rawEvent) => verifyWebhookSignature(client, webhookId, headers, rawEvent) },
    webhookId: env().PAYPAL_WEBHOOK_ID ?? null,
    now: () => new Date(),
    senderLimit: serverSenderLimit,
    verifyLimit: serverVerifyLimit,
  };
}
