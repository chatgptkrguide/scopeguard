import type { ChangeOrder, ChangeOrderStatus } from "./types";

// The only allowed moves, and the one place they are listed. Anything else is a bug or a replayed request. The guarded
// UPDATEs in server/db/change-orders.ts each make one of these moves (markPaidFromDraft makes draft → sent → paid in one
// step); what a status needs to hold (a sent order has an invoice id, a sent date and an amount above zero, a paid one
// a paid date) is checked by the CHECK constraints in server/db/schema.ts.
// draft → cancelled happens only when PayPal already shows the order's invoice as cancelled, or its number is used
// up by an invoice nobody can pay; the app never cancels a draft by itself (P2-D4). It lets the finding be quoted
// again under a new number.
const TRANSITIONS = {
  draft: ["sent", "waived", "cancelled"],
  sent: ["paid", "cancelled"],
  paid: [],
  waived: [],
  cancelled: [],
} as const satisfies Record<ChangeOrderStatus, readonly ChangeOrderStatus[]>;

export function canTransition(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return (TRANSITIONS[from] as readonly ChangeOrderStatus[]).includes(to);
}

// Orders that count toward the project total. Waived and cancelled work is shown but not billed.
export function isBillable(order: Pick<ChangeOrder, "status">): boolean {
  return isUnpaid(order) || order.status === "paid";
}

// Billable work the client hasn't paid for yet: drafts and sent invoices.
export function isUnpaid(order: Pick<ChangeOrder, "status">): boolean {
  return order.status === "draft" || order.status === "sent";
}
