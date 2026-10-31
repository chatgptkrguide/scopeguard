import "server-only";
import type { BatchItem } from "drizzle-orm/batch";
import type { BillingActionResult } from "@/domain/action-result";
import { invoiceNumberFor } from "@/domain/invoice";
import { formatUsd } from "@/domain/money";
import { paymentDecision, paymentPrecheck, type PaymentDecision } from "@/domain/payment";
import { actionErrorFor, errorDetail, failureSummary, recordFailure, type BillingDeps } from "./billing";
import { activityInsertAfterChange } from "./db/activity";
import { markPaid, markPaidFromDraft, ownedStatus, readPayableOrder, type PayableOrder } from "./db/change-orders";
import type { Db } from "./db/client";
import { PayPalError } from "./paypal/errors";
import type { InvoiceView } from "./paypal/invoices";

// Settling a paid invoice: the payment webhook, "Check payment" and a send PayPal refused because the invoice is
// already paid all end here, with the rule in domain/payment.ts. The status change is one conditional UPDATE, so
// when two of them arrive together only one moves the order, and only that one leaves activity steps behind.

export type PaymentSource = "webhook" | "check" | "send";

// The statements that settle an order, for a db.batch(): the UPDATE, then its activity steps, each written only if
// the statement before it changed a row (activityInsertAfterChange). From a draft: invoice_sent (recovered: true)
// then payment_confirmed. Empty for any decision but "settle".
export function settleStatements(
  db: Db,
  order: PayableOrder,
  invoice: InvoiceView,
  decision: PaymentDecision,
  at: string,
  source: PaymentSource,
  eventId?: string,
): BatchItem<"sqlite">[] {
  if (decision.kind !== "settle") return [];
  const invoiceId = invoice.id;
  const invoiceNumber = invoice.invoiceNumber ?? invoiceNumberFor(order.id);
  const confirmed = activityInsertAfterChange(db, {
    projectId: order.projectId,
    changeOrderId: order.id,
    kind: "payment_confirmed",
    actor: "paypal",
    summary: `PayPal shows invoice ${invoiceNumber} as paid in full (${formatUsd(order.amountCents)})`,
    detail: { invoiceId, paypalStatus: invoice.status, amount: invoice.amountValue, source, eventId: eventId ?? null },
    at,
  });
  if (decision.from === "sent") return [markPaid(db, order, invoiceId, at), confirmed];
  return [
    markPaidFromDraft(db, order, invoiceId, at, invoice.payerViewUrl),
    activityInsertAfterChange(db, {
      projectId: order.projectId,
      changeOrderId: order.id,
      kind: "invoice_sent",
      actor: "paypal",
      summary: `Invoice ${invoiceNumber} had gone out to the client; recorded as sent when PayPal showed it paid`,
      detail: { invoiceId, paypalStatus: invoice.status, payerViewUrl: invoice.payerViewUrl, recovered: true },
      at,
    }),
    confirmed,
  ];
}

type BillingError = Extract<BillingActionResult, { ok: false }>["error"];
const OK: BillingActionResult = { ok: true };
const fail = (error: BillingError): BillingActionResult => ({ ok: false, error });

// "Check payment": owner check → precheck → read the invoice → decide → batch. Never takes amounts from the form.
// ok: the order is paid (now or before) · not_paid_yet · invoice_changed (mismatch) · invalid_state (waived, cancelled,
// draft without invoice) · not_found · not_configured · paypal_unavailable / paypal_rejected (read failed, recorded
// as a paypal_failed step "read").
export async function checkOwnedPayment(deps: BillingDeps, ownerProjectId: string, changeOrderId: string): Promise<BillingActionResult> {
  const { db, paypal, now } = deps;
  if (!paypal) return fail("not_configured");

  const order = await readPayableOrder(db, ownerProjectId, changeOrderId);
  if (!order) return fail("not_found");
  const precheck = paymentPrecheck(order);
  if (precheck === "already_paid") return OK;
  if (precheck !== "read" || !order.paypalInvoiceId) return fail("invalid_state");

  let invoice: InvoiceView;
  try {
    invoice = await paypal.get(order.paypalInvoiceId);
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    console.error("PayPal read failed while checking a payment", error);
    await recordFailure(deps, { ownerProjectId, changeOrderId, step: "read", summary: failureSummary(error, "read"), detail: errorDetail(error) });
    return fail(actionErrorFor(error));
  }

  const decision = paymentDecision(order, invoice);
  if (decision.kind === "mismatch") {
    console.error(`invoice ${invoice.id} doesn't match its change order's reference or amount; not marked paid`);
    return fail("invoice_changed");
  }
  const [first, ...rest] = settleStatements(db, order, invoice, decision, now().toISOString(), "check");
  if (!first) return fail("not_paid_yet");
  await db.batch([first, ...rest]);
  // Paid by this batch or by a webhook that got there first; anything else moved the order meanwhile (a cancel).
  const status = await ownedStatus(db, ownerProjectId, changeOrderId);
  if (status === "paid") return OK;
  return fail(status === null ? "not_found" : "invalid_state");
}
