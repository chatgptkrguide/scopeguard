// Core entities. Money is integer cents, dates are ISO strings (UTC).

export interface Project {
  id: string;
  clientName: string;
  clientEmail: string;
  title: string;
  hourlyRateCents: number;
  hoursPerDay: number;
  agreedOn: string;
  dueOn: string;
}

export interface ScopeItem {
  id: string;
  projectId: string;
  title: string;
  amountCents: number;
  position: number;
}

export type MessageAuthor = "client" | "me";

export interface Message {
  id: string;
  projectId: string;
  from: MessageAuthor;
  author: string;
  sentAt: string;
  body: string;
}

// A phrase in a client message that adds work beyond the agreed scope.
export interface Finding {
  id: string;
  messageId: string;
  quote: string;
  title: string;
  estimatedHours: number;
  reason: string;
}

export interface ChangeOrder {
  id: string;
  projectId: string;
  findingId: string;
  title: string;
  hours: number;
  amountCents: number;
  extraDays: number;
  status: ChangeOrderStatus;
  paypalInvoiceId: string | null;
  payerViewUrl: string | null;
  sentAt: string | null;
  paidAt: string | null;
}

export const CHANGE_ORDER_STATUSES = ["draft", "sent", "paid", "waived", "cancelled"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];
