import "server-only";
import type { ActivityDetail } from "@/domain/activity";
import type { ActionResult, BillingActionResult, PayPalActionError } from "@/domain/action-result";
import { canTransition } from "@/domain/change-order";
import { invoiceNumberFor, SENT_LIKE } from "@/domain/invoice";
import { extraDaysForHours, formatUsd, priceForHours, toPayPalValue } from "@/domain/money";
import { activityInsert, activityInsertAfterChange } from "./db/activity";
import {
  claimSend,
  markCancelled,
  markSent,
  markVoided,
  ownedStatus,
  readBillingOrder,
  releaseSendClaim,
  saveInvoiceId,
  SEND_CLAIM_TTL_MS,
  type BillingOrder,
} from "./db/change-orders";
import { getDb, type Db } from "./db/client";
import { isUniqueViolation } from "./db/errors";
import { changeOrders } from "./db/schema";
import { PayPalError } from "./paypal/errors";
import {
  cancelInvoice,
  createInvoice,
  getInvoice,
  INVOICE_NUMBER_USED_UP,
  sendInvoice,
  type InvoiceInput,
  type InvoiceRef,
  type InvoiceView,
} from "./paypal/invoices";
import { getPayPal, type PayPalClient } from "./paypal/token";

// Sending, cancelling and quoting again: the database and PayPal together. Every database write is one
// statement or one db.batch(); no transaction stays open while PayPal is called. A state change and its
// activity step land in the same batch. Nothing here returns an invoice id, a PayPal error text or a debug
// id to the browser; those go to the server log and the activity record only.

// The PayPal side as plain functions: invoices.ts with the server's client in production, a fake in tests.
export interface InvoiceGateway {
  create(input: InvoiceInput): Promise<InvoiceRef & { created: boolean }>;
  send(invoiceId: string): Promise<"sent" | "already_sent">;
  get(invoiceId: string): Promise<InvoiceView>;
  cancel(invoiceId: string): Promise<"cancelled" | "already_cancelled" | "paid">;
}

export interface BillingDeps {
  db: Db;
  paypal: InvoiceGateway | null; // null: no PayPal keys on this server
  now: () => Date; // read again at each step, so activity times follow the steps
}

export function invoiceGateway(client: PayPalClient): InvoiceGateway {
  return {
    create: (input) => createInvoice(client, input),
    send: (invoiceId) => sendInvoice(client, invoiceId),
    get: (invoiceId) => getInvoice(client, invoiceId),
    cancel: (invoiceId) => cancelInvoice(client, invoiceId),
  };
}

export function liveBillingDeps(): BillingDeps {
  const client = getPayPal();
  return { db: getDb(), paypal: client && invoiceGateway(client), now: () => new Date() };
}

export { SEND_CLAIM_TTL_MS };

type PayPalStep = "create" | "send" | "read" | "cancel";

type BillingError = Extract<BillingActionResult, { ok: false }>["error"];
const OK: BillingActionResult = { ok: true };
const fail = (error: BillingError): BillingActionResult => ({ ok: false, error });

const stepText: Record<PayPalStep, string> = {
  create: "creating the invoice",
  send: "sending the invoice",
  read: "reading the invoice back",
  cancel: "cancelling the invoice",
};

// What a refusal at each step leaves behind. Once the invoice was sent, nothing may claim that nothing happened.
const refusalMeans: Record<PayPalStep, string> = {
  create: "no invoice was made",
  send: "it wasn't sent",
  read: "it was sent but couldn't be confirmed",
  cancel: "the invoice is still open",
};

function failureSummary(error: PayPalError, step: PayPalStep): string {
  switch (error.failure) {
    case "rejected":
      return `PayPal refused the request while ${stepText[step]}${error.issue ? ` (${error.issue})` : ""}; ${refusalMeans[step]}.`;
    case "auth":
      return `PayPal didn't accept the app's credentials while ${stepText[step]}.`;
    case "not_found":
      return `PayPal couldn't find the invoice while ${stepText[step]}.`;
    default:
      return `PayPal didn't respond while ${stepText[step]}; trying again won't bill the client twice.`;
  }
}

function actionErrorFor(error: PayPalError): PayPalActionError {
  if (error.failure === "not_configured") return "not_configured";
  return error.failure === "rejected" ? "paypal_rejected" : "paypal_unavailable";
}

const hoursFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

// What PayPal shows the client. Everything comes from the database, never from the form.
function invoiceInputFor(order: BillingOrder): InvoiceInput {
  const { project } = order;
  const exactCents = (Math.round(order.hours * 100) * project.hourlyRateCents) / 100;
  const rounded = order.amountCents > exactCents ? ", rounded up to the next $10" : "";
  return {
    changeOrderId: order.id,
    title: order.title,
    description: `Estimated ${hoursFormat.format(order.hours)} h at ${formatUsd(project.hourlyRateCents)}/h${rounded}`,
    note: `Change order for ${project.title}. Not part of the agreed scope.`,
    amountCents: order.amountCents,
    recipient: { email: project.clientEmail, businessName: project.clientName },
  };
}

interface FailureRecord {
  ownerProjectId: string;
  changeOrderId: string;
  step: PayPalStep;
  summary: string;
  detail: ActivityDetail;
}

// Best effort: a failed PayPal call is logged and recorded, but failing to record it never changes the answer.
async function recordFailure(deps: BillingDeps, record: FailureRecord): Promise<void> {
  try {
    await activityInsert(deps.db, {
      projectId: record.ownerProjectId,
      changeOrderId: record.changeOrderId,
      kind: "paypal_failed",
      actor: "paypal",
      summary: record.summary,
      detail: { step: record.step, ...record.detail },
      at: deps.now().toISOString(),
    });
  } catch (error) {
    console.error("recording a PayPal failure failed", error);
  }
}

function errorDetail(error: PayPalError): ActivityDetail {
  return { httpStatus: error.httpStatus, issue: error.issue, debugId: error.debugId };
}

// Best effort: a claim that can't be given up (the database is down) expires after SEND_CLAIM_TTL_MS anyway.
async function releaseQuietly(db: Db, ownerProjectId: string, changeOrderId: string, claim: string): Promise<void> {
  try {
    await releaseSendClaim(db, ownerProjectId, changeOrderId, claim);
  } catch (error) {
    console.error("releasing a send claim failed", error);
  }
}

interface VoidRecord {
  invoiceId: string | null; // null when the number is taken by an invoice this order never saved
  paypalStatus: string | null;
  summary: string;
}

// The order's invoice can never go out: PayPal shows it cancelled, or its number is used up (P2-D4). The draft
// becomes cancelled, so "Quote again" gives the finding a new order and a new number; nobody can pay the old
// invoice, so nothing is left untracked. Runs while this request holds the claim, and clears it.
async function voidDraft(deps: BillingDeps, ownerProjectId: string, changeOrderId: string, claim: string, record: VoidRecord): Promise<BillingActionResult> {
  const { db, now } = deps;
  const [voided] = await db.batch([
    markVoided(db, ownerProjectId, changeOrderId, claim),
    activityInsertAfterChange(db, {
      projectId: ownerProjectId,
      changeOrderId,
      kind: "invoice_cancelled",
      actor: "paypal",
      summary: record.summary,
      detail: { invoiceId: record.invoiceId, paypalStatus: record.paypalStatus, voided: true },
      at: now().toISOString(),
    }),
  ]);
  if (voided.rowsAffected > 0) return fail("invoice_void");
  // This request outlived its claim and another one took over.
  const status = await ownedStatus(db, ownerProjectId, changeOrderId);
  if (status === "cancelled") return fail("invoice_void");
  if (status === "draft") return fail("in_progress");
  return status === "sent" ? OK : fail(status === null ? "not_found" : "invalid_state");
}

// PayPal's status for the invoice, or null if it can't be read just now.
async function statusIfReadable(paypal: InvoiceGateway, invoiceId: string): Promise<string | null> {
  try {
    return (await paypal.get(invoiceId)).status;
  } catch {
    return null;
  }
}

// draft → sent. Order of work: check the owner and status, claim the send (one conditional UPDATE), create the
// invoice unless the order already has one, save its id before sending, send, read it back, then save sent and
// the payer link. A request that loses the claim stops before PayPal. If PayPal already has an invoice with this
// order's number (an earlier try created it but never saved the id), createInvoice finds and reuses it.
// Every way out gives the claim back, a database error included, so a retry isn't held off for two minutes. Once
// PayPal was asked to send, a failure answers paypal_unconfirmed, never "nothing changed": the client may have the
// invoice, and Send again settles it either way (P2-D2). An invoice PayPal shows as cancelled, or a number that is
// used up, makes the draft cancelled so it can be quoted again (P2-D4).
export async function sendOwnedChangeOrder(deps: BillingDeps, ownerProjectId: string, changeOrderId: string): Promise<BillingActionResult> {
  const { db, paypal, now } = deps;
  if (!paypal) return fail("not_configured");

  const order = await readBillingOrder(db, ownerProjectId, changeOrderId);
  if (!order) return fail("not_found");
  if (order.status === "sent") return OK;
  if (!canTransition(order.status, "sent") || !(order.amountCents > 0)) return fail("invalid_state");

  const claimedAt = now();
  const claim = claimedAt.toISOString();
  const staleBefore = new Date(claimedAt.getTime() - SEND_CLAIM_TTL_MS).toISOString();
  if (!(await claimSend(db, ownerProjectId, changeOrderId, claim, staleBefore))) {
    const status = await ownedStatus(db, ownerProjectId, changeOrderId);
    if (status === "sent") return OK;
    if (status === "draft") return fail("in_progress");
    return fail(status === null ? "not_found" : "invalid_state");
  }
  const release = () => releaseQuietly(db, ownerProjectId, changeOrderId, claim);

  const invoiceNumber = invoiceNumberFor(changeOrderId);
  let step: PayPalStep = "create";
  let sendAsked = false; // set just before PayPal is asked to send: from then on the client may have the invoice
  try {
    // Read again under the claim: a request that held it before may have saved an invoice id since.
    const current = await readBillingOrder(db, ownerProjectId, changeOrderId);
    if (current?.status !== "draft") {
      await release();
      return fail(current === null ? "not_found" : "invalid_state");
    }
    let invoiceId = current.paypalInvoiceId;
    if (!invoiceId) {
      let created: InvoiceRef & { created: boolean };
      try {
        created = await paypal.create(invoiceInputFor(current));
      } catch (error) {
        if (!(error instanceof PayPalError) || error.issue !== INVOICE_NUMBER_USED_UP) throw error;
        return await voidDraft(deps, ownerProjectId, changeOrderId, claim, {
          invoiceId: null,
          paypalStatus: null,
          summary: `PayPal already has invoice ${invoiceNumber}, cancelled there or not matching this change order, so it was marked cancelled; quote it again for a new invoice`,
        });
      }
      const [saved] = await db.batch([
        saveInvoiceId(db, ownerProjectId, changeOrderId, created.id, claim),
        activityInsertAfterChange(db, {
          projectId: ownerProjectId,
          changeOrderId,
          kind: "invoice_created",
          actor: "paypal",
          summary: created.created
            ? `Created PayPal invoice ${created.invoiceNumber} for ${formatUsd(current.amountCents)} (draft)`
            : `Found the PayPal invoice from an earlier try: ${created.invoiceNumber}`,
          detail: {
            invoiceId: created.id,
            invoiceNumber: created.invoiceNumber,
            amount: toPayPalValue(current.amountCents),
            currency: "USD",
            reused: !created.created,
          },
          at: now().toISOString(),
        }),
      ]);
      if (saved.rowsAffected === 0) {
        const after = await readBillingOrder(db, ownerProjectId, changeOrderId);
        if (after?.paypalInvoiceId !== created.id) {
          await release();
          return fail("server_error");
        }
      }
      invoiceId = created.id;
    }

    const cancelledInPayPal = (paypalStatus: string) =>
      voidDraft(deps, ownerProjectId, changeOrderId, claim, {
        invoiceId,
        paypalStatus,
        summary: `PayPal shows invoice ${invoiceNumber} as cancelled, so this change order was marked cancelled; quote it again for a new invoice`,
      });

    // A request that outlived its claim may be sending this same invoice right now; PayPal is assumed to handle
    // the two sends one at a time (SEND_CLAIM_TTL_MS, P2-D3).
    step = "send";
    sendAsked = true;
    let sendResult: "sent" | "already_sent";
    try {
      sendResult = await paypal.send(invoiceId);
    } catch (error) {
      // PayPal won't send an invoice someone cancelled there. Read it back to tell that apart from other refusals.
      if (error instanceof PayPalError && error.failure === "rejected" && (await statusIfReadable(paypal, invoiceId)) === "CANCELLED") {
        return await cancelledInPayPal("CANCELLED");
      }
      throw error;
    }
    step = "read";
    const invoice = await paypal.get(invoiceId);

    // Someone cancelled it in PayPal: the draft becomes cancelled (PM decision [6], extended by P2-D4).
    if (invoice.status === "CANCELLED") return await cancelledInPayPal(invoice.status);
    // PayPal doesn't show it as out yet: don't call it sent. PayPal accepted the send, though, so the answer
    // can't be that nothing changed.
    if (!SENT_LIKE.has(invoice.status)) {
      await release();
      await recordFailure(deps, {
        ownerProjectId,
        changeOrderId,
        step,
        summary: `PayPal accepted the send but shows the invoice as ${invoice.status}, so it isn't marked sent yet.`,
        detail: { httpStatus: 200, issue: invoice.status, debugId: null },
      });
      return fail("paypal_unconfirmed");
    }

    const sentAt = now().toISOString();
    const [marked] = await db.batch([
      markSent(db, ownerProjectId, changeOrderId, invoiceId, sentAt, invoice.payerViewUrl),
      activityInsertAfterChange(db, {
        projectId: ownerProjectId,
        changeOrderId,
        kind: "invoice_sent",
        actor: "paypal",
        summary: `Sent invoice ${invoiceNumber} to ${current.project.clientEmail}`,
        detail: { invoiceId, paypalStatus: invoice.status, payerViewUrl: invoice.payerViewUrl, alreadySent: sendResult === "already_sent" },
        at: sentAt,
      }),
    ]);
    if (marked.rowsAffected === 0) {
      return (await ownedStatus(db, ownerProjectId, changeOrderId)) === "sent" ? OK : fail("invalid_state");
    }
    return OK;
  } catch (error) {
    await release();
    if (!(error instanceof PayPalError)) {
      // A database error before PayPal was asked to send: nothing went out, and the action answers server_error.
      if (!sendAsked) throw error;
      console.error("saving a sent invoice failed", error);
      return fail("paypal_unconfirmed");
    }
    console.error(`PayPal ${step} failed`, error);
    await recordFailure(deps, { ownerProjectId, changeOrderId, step, summary: failureSummary(error, step), detail: errorDetail(error) });
    // A failed read comes after PayPal accepted the send.
    return fail(step === "read" ? "paypal_unconfirmed" : actionErrorFor(error));
  }
}

// sent → cancelled, after PayPal cancels the invoice. No claim is needed: a second cancel answers
// INVOICE_CANCELED_ALREADY and the UPDATE only moves a sent order. A paid invoice stays sent here; the payment
// webhook or "Check payment" (P3) moves it to paid.
export async function cancelOwnedChangeOrder(deps: BillingDeps, ownerProjectId: string, changeOrderId: string): Promise<BillingActionResult> {
  const { db, paypal, now } = deps;
  if (!paypal) return fail("not_configured");

  const order = await readBillingOrder(db, ownerProjectId, changeOrderId);
  if (!order) return fail("not_found");
  if (order.status === "cancelled") return OK;
  if (order.status !== "sent" || !order.paypalInvoiceId) return fail("invalid_state");
  const invoiceId = order.paypalInvoiceId;

  let result: "cancelled" | "already_cancelled" | "paid";
  try {
    result = await paypal.cancel(invoiceId);
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    console.error("PayPal cancel failed", error);
    await recordFailure(deps, { ownerProjectId, changeOrderId, step: "cancel", summary: failureSummary(error, "cancel"), detail: errorDetail(error) });
    return fail(actionErrorFor(error));
  }

  if (result === "paid") {
    await recordFailure(deps, {
      ownerProjectId,
      changeOrderId,
      step: "cancel",
      summary: "PayPal says the client already paid, so the invoice wasn't cancelled.",
      detail: { httpStatus: 422, issue: "CANNOT_CANCEL_PAID_INVOICE", debugId: null },
    });
    return fail("already_paid");
  }

  let moved: { rowsAffected: number };
  try {
    [moved] = await db.batch([
      markCancelled(db, ownerProjectId, changeOrderId),
      activityInsertAfterChange(db, {
        projectId: ownerProjectId,
        changeOrderId,
        kind: "invoice_cancelled",
        actor: "paypal",
        summary: `Cancelled invoice ${invoiceNumberFor(changeOrderId)} in PayPal`,
        detail: { invoiceId, alreadyCancelled: result === "already_cancelled" },
        at: now().toISOString(),
      }),
    ]);
  } catch (error) {
    // PayPal did cancel it; only saving that failed. Cancelling again answers INVOICE_CANCELED_ALREADY and saves it
    // then, so the answer says so instead of "nothing changed" (P2-D6).
    console.error("saving a cancelled invoice failed", error);
    return fail("paypal_unconfirmed");
  }
  if (moved.rowsAffected === 0) {
    const status = await ownedStatus(db, ownerProjectId, changeOrderId);
    if (status === "cancelled") return OK;
    return fail(status === null ? "not_found" : "invalid_state");
  }
  return OK;
}

// A cancelled order's finding quoted again: a new draft with a new id (so PayPal gets a new invoice number),
// priced again from the project's rate rather than copied (principle 2). PM decision [4].
export async function requoteOwnedChangeOrder(db: Db, ownerProjectId: string, cancelledOrderId: string): Promise<ActionResult> {
  const order = await readBillingOrder(db, ownerProjectId, cancelledOrderId);
  if (!order) return { ok: false, error: "not_found" };
  if (order.status !== "cancelled") return { ok: false, error: "invalid_state" };

  try {
    await db.insert(changeOrders).values({
      id: crypto.randomUUID(),
      projectId: ownerProjectId,
      findingId: order.findingId,
      title: order.title,
      hours: order.hours,
      amountCents: priceForHours(order.hours, order.project.hourlyRateCents),
      extraDays: extraDaysForHours(order.hours, order.project.hoursPerDay),
      status: "draft",
    });
  } catch (error) {
    // The finding already has a live order (quoted again by another request): that is the result wanted.
    if (isUniqueViolation(error)) return { ok: true };
    throw error;
  }
  return { ok: true };
}
