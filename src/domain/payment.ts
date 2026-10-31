import { INVOICE_CURRENCY, PAYMENT_AWAITED, SETTLED, type PayPalInvoiceStatus } from "./invoice";
import { toPayPalValue } from "./money";
import type { ChangeOrderStatus } from "./types";

// When a change order counts as paid. One rule for the payment webhook, "Check payment" and a send PayPal refused
// because the invoice is already paid, so the three can never disagree. No I/O.

export interface PaymentOrder {
  id: string;
  status: ChangeOrderStatus;
  amountCents: number;
  paypalInvoiceId: string | null;
}

// What PayPal says about the invoice, read back from PayPal (never taken from a webhook event or a form).
export interface InvoiceFacts {
  status: PayPalInvoiceStatus;
  reference: string | null; // the change order id the invoice was made for
  amountValue: string | null; // "650.00"
  currencyCode: string | null; // "USD"
}

// Before reading PayPal: is there anything to settle?
// read: a sent order, or a draft that already holds an invoice id (the app stopped between sending and saving sent)
// already_paid: nothing to do · closed: waived or cancelled · no_invoice: a draft PayPal has no invoice for
export type PaymentPrecheck = "read" | "already_paid" | "closed" | "no_invoice";

export function paymentPrecheck(order: PaymentOrder): PaymentPrecheck {
  switch (order.status) {
    case "sent":
      return "read";
    case "draft":
      return order.paypalInvoiceId === null ? "no_invoice" : "read";
    case "paid":
      return "already_paid";
    default:
      return "closed";
  }
}

export type PaymentDecision =
  | { kind: "settle"; from: "sent" | "draft" } // draft: recorded as sent, then paid
  | { kind: "not_settled"; awaited: boolean } // awaited: PayPal may still show it paid in full (PAYMENT_AWAITED)
  | { kind: "mismatch" }; // the invoice's reference isn't this order's id, or its amount or currency isn't the order's

// Only for an order paymentPrecheck answered "read" for. The reference, amount and currency are checked first: an
// invoice that doesn't belong to this order at this price never settles it, whatever its status.
export function paymentDecision(order: PaymentOrder, invoice: InvoiceFacts): PaymentDecision {
  if (paymentPrecheck(order) !== "read") throw new RangeError(`no payment to decide for a ${order.status} order`);
  const samePrice = invoice.amountValue === toPayPalValue(order.amountCents) && invoice.currencyCode === INVOICE_CURRENCY;
  if (invoice.reference !== order.id || !samePrice) return { kind: "mismatch" };
  if (SETTLED.has(invoice.status)) return { kind: "settle", from: order.status === "draft" ? "draft" : "sent" };
  return { kind: "not_settled", awaited: PAYMENT_AWAITED.has(invoice.status) };
}
