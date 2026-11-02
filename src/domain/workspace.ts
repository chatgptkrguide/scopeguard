import { isBillable, isUnpaid } from "./change-order";
import { sumCents } from "./money";
import type { ChangeOrder, Finding, Message, Project, ScopeItem } from "./types";

// What the workspace screen shows for one project. The screen renders this as is and never re-adds money.

export interface FindingWithOrder {
  finding: Finding; // quoteStart/quoteEnd are the only place the screen marks
  order: ChangeOrder | null; // see displayedOrder
}

export interface ThreadMessage extends Message {
  findings: readonly FindingWithOrder[]; // by quoteStart
}

export interface ProjectTotals {
  agreedCents: number; // the agreed scope
  changeOrdersCents: number; // draft, sent and paid orders; waived and cancelled are shown but not counted
  totalCents: number; // agreed + change orders ("With changes", "Total")
  paidCents: number; // paid orders only
  hasUnpaid: boolean; // a draft or sent order is still open
}

export interface WorkspaceData {
  project: Project;
  scopeItems: readonly ScopeItem[]; // by position
  messages: readonly ThreadMessage[]; // by sentAt
  changeOrders: readonly ChangeOrder[]; // by message sentAt, then quoteStart; every status
  totals: ProjectTotals;
}

export function projectTotals(
  scopeItems: readonly Pick<ScopeItem, "amountCents">[],
  orders: readonly Pick<ChangeOrder, "status" | "amountCents">[],
): ProjectTotals {
  const agreedCents = sumCents(scopeItems.map((i) => i.amountCents));
  const changeOrdersCents = sumCents(orders.filter(isBillable).map((o) => o.amountCents));
  return {
    agreedCents,
    changeOrdersCents,
    totalCents: agreedCents + changeOrdersCents,
    paidCents: sumCents(orders.filter((o) => o.status === "paid").map((o) => o.amountCents)),
    hasUnpaid: orders.some(isUnpaid),
  };
}

// The order a finding shows: its live one; after a cancel with no new quote, the cancelled one sent last; else none.
export function displayedOrder(orders: readonly ChangeOrder[]): ChangeOrder | null {
  const live = orders.find((o) => o.status !== "cancelled");
  if (live) return live;
  const cancelled = orders.filter((o) => o.status === "cancelled");
  return cancelled.reduce<ChangeOrder | null>(
    (latest, o) => (latest === null || (o.sentAt ?? "") > (latest.sentAt ?? "") ? o : latest),
    null,
  );
}
