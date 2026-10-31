import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { ActionResult } from "../../domain/action-result";
import { canTransition } from "../../domain/change-order";
import type { ChangeOrderStatus } from "../../domain/types";
import type { Db } from "./client";
import { changeOrders, projects } from "./schema";

// Change order commands. Each one reads the order only through its owner's project id,
// so another copy's order looks exactly like one that doesn't exist.

function owned(ownerProjectId: string, changeOrderId: string) {
  return and(eq(changeOrders.id, changeOrderId), eq(changeOrders.projectId, ownerProjectId));
}

export async function ownedStatus(db: Db, ownerProjectId: string, changeOrderId: string): Promise<ChangeOrderStatus | null> {
  const [row] = await db.select({ status: changeOrders.status }).from(changeOrders).where(owned(ownerProjectId, changeOrderId));
  return row?.status ?? null;
}

// draft → waived. Waiving twice is fine; anything already sent, paid or cancelled is refused.
export async function waiveOwnedChangeOrder(db: Db, ownerProjectId: string, changeOrderId: string): Promise<ActionResult> {
  const status = await ownedStatus(db, ownerProjectId, changeOrderId);
  if (status === null) return { ok: false, error: "not_found" };
  if (status === "waived") return { ok: true };
  if (!canTransition(status, "waived")) return { ok: false, error: "invalid_state" };

  // Only flips the status that was just read, so a concurrent change in between can't be overwritten.
  const { rowsAffected } = await db
    .update(changeOrders)
    .set({ status: "waived" })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.status, status)));
  if (rowsAffected > 0) return { ok: true };

  const now = await ownedStatus(db, ownerProjectId, changeOrderId);
  if (now === "waived") return { ok: true };
  return { ok: false, error: now === null ? "not_found" : "invalid_state" };
}

// What sending, cancelling and quoting again need: the order and its project's client and rate,
// read only through the owner's project id.
export interface BillingOrder {
  id: string;
  findingId: string;
  title: string;
  hours: number;
  amountCents: number;
  status: ChangeOrderStatus;
  paypalInvoiceId: string | null;
  project: { title: string; clientName: string; clientEmail: string; hourlyRateCents: number; hoursPerDay: number };
}

export async function readBillingOrder(db: Db, ownerProjectId: string, changeOrderId: string): Promise<BillingOrder | null> {
  const [row] = await db
    .select({
      id: changeOrders.id,
      findingId: changeOrders.findingId,
      title: changeOrders.title,
      hours: changeOrders.hours,
      amountCents: changeOrders.amountCents,
      status: changeOrders.status,
      paypalInvoiceId: changeOrders.paypalInvoiceId,
      project: {
        title: projects.title,
        clientName: projects.clientName,
        clientEmail: projects.clientEmail,
        hourlyRateCents: projects.hourlyRateCents,
        hoursPerDay: projects.hoursPerDay,
      },
    })
    .from(changeOrders)
    .innerJoin(projects, eq(projects.id, changeOrders.projectId))
    .where(owned(ownerProjectId, changeOrderId));
  return row ?? null;
}

// The send claim. One conditional UPDATE: only a draft with no claim, or a claim older than staleBefore,
// can be claimed, so of two requests for the same order exactly one gets true and goes on to PayPal.
export async function claimSend(db: Db, ownerProjectId: string, changeOrderId: string, claim: string, staleBefore: string): Promise<boolean> {
  const { rowsAffected } = await db
    .update(changeOrders)
    .set({ sendClaimedAt: claim })
    .where(
      and(
        owned(ownerProjectId, changeOrderId),
        eq(changeOrders.status, "draft"),
        or(isNull(changeOrders.sendClaimedAt), lt(changeOrders.sendClaimedAt, staleBefore)),
      ),
    );
  return rowsAffected > 0;
}

// Gives up this request's own claim (a later claim by another request is left alone).
export function releaseSendClaim(db: Db, ownerProjectId: string, changeOrderId: string, claim: string) {
  return db
    .update(changeOrders)
    .set({ sendClaimedAt: null })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.sendClaimedAt, claim)));
}

// Stores the PayPal invoice id before sending, while this request still holds the claim.
export function saveInvoiceId(db: Db, ownerProjectId: string, changeOrderId: string, invoiceId: string, claim: string) {
  return db
    .update(changeOrders)
    .set({ paypalInvoiceId: invoiceId })
    .where(
      and(
        owned(ownerProjectId, changeOrderId),
        eq(changeOrders.status, "draft"),
        isNull(changeOrders.paypalInvoiceId),
        eq(changeOrders.sendClaimedAt, claim),
      ),
    );
}

// draft → sent, only for the invoice that was just sent. Clears the claim.
export function markSent(db: Db, ownerProjectId: string, changeOrderId: string, invoiceId: string, sentAt: string, payerViewUrl: string | null) {
  return db
    .update(changeOrders)
    .set({ status: "sent", sentAt, payerViewUrl, sendClaimedAt: null })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.status, "draft"), eq(changeOrders.paypalInvoiceId, invoiceId)));
}

// sent → cancelled, after PayPal cancelled the invoice.
export function markCancelled(db: Db, ownerProjectId: string, changeOrderId: string) {
  return db
    .update(changeOrders)
    .set({ status: "cancelled" })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.status, "sent")));
}
