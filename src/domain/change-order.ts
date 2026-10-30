import type { ChangeOrder, ChangeOrderStatus } from "./types";

// The only allowed moves. Anything else is a bug or a replayed request.
const TRANSITIONS = {
  draft: ["sent", "waived"],
  sent: ["paid", "cancelled"],
  paid: [],
  waived: [],
  cancelled: [],
} as const satisfies Record<ChangeOrderStatus, readonly ChangeOrderStatus[]>;

export class TransitionError extends Error {
  constructor(
    readonly from: ChangeOrderStatus,
    readonly to: ChangeOrderStatus,
  ) {
    super(`change order cannot go from ${from} to ${to}`);
    this.name = "TransitionError";
  }
}

export function canTransition(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return (TRANSITIONS[from] as readonly ChangeOrderStatus[]).includes(to);
}

interface TransitionDetails {
  at?: string;
  paypalInvoiceId?: string;
  payerViewUrl?: string | null;
}

export function transition(order: ChangeOrder, to: ChangeOrderStatus, details: TransitionDetails = {}): ChangeOrder {
  if (!canTransition(order.status, to)) throw new TransitionError(order.status, to);
  const at = details.at ?? new Date().toISOString();
  switch (to) {
    case "sent": {
      const paypalInvoiceId = details.paypalInvoiceId ?? order.paypalInvoiceId;
      if (!paypalInvoiceId) throw new Error("a sent change order needs a PayPal invoice id");
      return { ...order, status: to, paypalInvoiceId, payerViewUrl: details.payerViewUrl ?? order.payerViewUrl, sentAt: at };
    }
    case "paid":
      return { ...order, status: to, paidAt: at };
    default:
      return { ...order, status: to };
  }
}

// Orders that count toward the project total. Waived and cancelled work is shown but not billed.
export function isBillable(order: Pick<ChangeOrder, "status">): boolean {
  return order.status === "draft" || order.status === "sent" || order.status === "paid";
}
