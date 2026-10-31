// What a server action tells the browser. Never a database row: only whether it worked and why not.
// server_error means the database failed (busy or unreachable) and nothing changed, so trying again may work.
export const ACTION_ERRORS = ["invalid_input", "not_found", "invalid_state", "server_error"] as const;
export type ActionError = (typeof ACTION_ERRORS)[number];
export type ActionResult = { ok: true } | { ok: false; error: ActionError };

// Extra answers from the PayPal actions (send, cancel) and from waiving, which has to respect them. Kept apart so
// the reset messages stay as they are.
// in_progress: another request is sending this order · paypal_unavailable: PayPal didn't answer, trying again is safe
// paypal_rejected: PayPal refused, nothing was sent or cancelled · already_paid: the client paid, so it can't be cancelled
// not_configured: this server has no PayPal keys
// invoice_exists: PayPal already has an invoice for this draft, so it can't be waived; sending again settles it
export const PAYPAL_ACTION_ERRORS = ["in_progress", "paypal_unavailable", "paypal_rejected", "already_paid", "not_configured", "invoice_exists"] as const;
export type PayPalActionError = (typeof PAYPAL_ACTION_ERRORS)[number];
export type BillingActionResult = { ok: true } | { ok: false; error: ActionError | PayPalActionError };
