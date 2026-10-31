import "server-only";
import type { BatchItem } from "drizzle-orm/batch";
import { invoiceNumberFor } from "@/domain/invoice";
import { formatUsd } from "@/domain/money";
import type { PaymentDecision } from "@/domain/payment";
import { activityInsertAfterChange } from "./db/activity";
import { markPaid, markPaidFromDraft, type PayableOrder } from "./db/change-orders";
import type { Db } from "./db/client";
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
