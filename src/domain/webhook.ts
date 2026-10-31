// What handling one PayPal webhook event came to, as stored in webhook_events.outcome. The schema imports this file
// by relative path (drizzle-kit can't read the "@/" alias).
export const WEBHOOK_OUTCOMES = [
  "settled", // the order moved (or already had moved) to paid
  "not_settled", // PayPal shows it partly paid, cancelled or refunded: the order stays sent. An invoice still awaiting
  // payment (unpaid or pending) isn't recorded: the webhook answers 503 so PayPal sends the event again (P3-S2)
  "paid_not_applied", // PayPal shows it paid, but the order had moved on (cancelled, say) before it could be marked paid (P3-C2)
  "mismatch", // reference, amount or currency differs from the order: not marked paid
  "unknown_invoice", // no change order holds this invoice id
  "already_paid", // the order was paid before this event (no PayPal call)
  "order_closed", // waived or cancelled order holding the id (logged as a warning)
  "ignored_type", // a verified event that isn't INVOICING.INVOICE.PAID
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

// The only event type that can settle a change order.
export const INVOICE_PAID_EVENT = "INVOICING.INVOICE.PAID";
