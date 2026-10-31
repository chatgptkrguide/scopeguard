import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { BillingActionResult } from "../../domain/action-result";
import { canTransition } from "../../domain/change-order";
import type { PaymentOrder } from "../../domain/payment";
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

// A send claim older than this is abandoned (the request died), and the next send takes it over. Longer than
// the slowest send: five PayPal calls of at most 10 s each, plus one 401 retry.
// Assumption, not confirmed in the sandbox (P2-D3): a request slower than this may still be running when the next
// one takes over, and both may then ask PayPal to send the same invoice at almost the same moment. The invoice
// number still stops a second invoice, but one email relies on PayPal handling the sends of one invoice one at a
// time, so one of them sends it and the other gets INVOICE_ALREADY_SENT (which counts as sent).
export const SEND_CLAIM_TTL_MS = 2 * 60 * 1000;

const staleClaimBefore = (now: Date) => new Date(now.getTime() - SEND_CLAIM_TTL_MS).toISOString();

interface WaiveCheck {
  status: ChangeOrderStatus;
  paypalInvoiceId: string | null;
  sendClaimedAt: string | null;
}

// Why an order can't be waived right now, or null if it can.
function waiveRefusal(order: WaiveCheck, staleBefore: string): BillingActionResult | null {
  if (order.status === "waived") return { ok: true };
  if (!canTransition(order.status, "waived")) return { ok: false, error: "invalid_state" };
  if (order.sendClaimedAt !== null && order.sendClaimedAt >= staleBefore) return { ok: false, error: "in_progress" };
  if (order.paypalInvoiceId !== null) return { ok: false, error: "invoice_exists" };
  return null;
}

// draft → waived. Waiving twice is fine; anything already sent, paid or cancelled is refused. So is a draft that
// already has a PayPal invoice (P2-D1): an earlier send may have reached the client before it stopped, and a
// waived order would leave that invoice payable with nothing tracking it, so it has to be sent again instead
// (and cancelled afterwards if need be). A draft whose send is under way is refused too. Both checks sit in the
// UPDATE itself, so a send that claims the order between the read and the write still wins.
export async function waiveOwnedChangeOrder(db: Db, ownerProjectId: string, changeOrderId: string, now: Date = new Date()): Promise<BillingActionResult> {
  const staleBefore = staleClaimBefore(now);
  const read = () =>
    db
      .select({ status: changeOrders.status, paypalInvoiceId: changeOrders.paypalInvoiceId, sendClaimedAt: changeOrders.sendClaimedAt })
      .from(changeOrders)
      .where(owned(ownerProjectId, changeOrderId));

  const [order] = await read();
  if (!order) return { ok: false, error: "not_found" };
  const refused = waiveRefusal(order, staleBefore);
  if (refused) return refused;

  const { rowsAffected } = await db
    .update(changeOrders)
    .set({ status: "waived" })
    .where(
      and(
        owned(ownerProjectId, changeOrderId),
        eq(changeOrders.status, "draft"),
        isNull(changeOrders.paypalInvoiceId),
        or(isNull(changeOrders.sendClaimedAt), lt(changeOrders.sendClaimedAt, staleBefore)),
      ),
    );
  if (rowsAffected > 0) return { ok: true };

  const [after] = await read();
  if (!after) return { ok: false, error: "not_found" };
  return waiveRefusal(after, staleBefore) ?? { ok: false, error: "invalid_state" };
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

// draft → cancelled, while this request holds the claim: PayPal shows the order's invoice as cancelled, or its
// number is used up (P2-D4). Clears the claim.
export function markVoided(db: Db, ownerProjectId: string, changeOrderId: string, claim: string) {
  return db
    .update(changeOrders)
    .set({ status: "cancelled", sendClaimedAt: null })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.status, "draft"), eq(changeOrders.sendClaimedAt, claim)));
}

// sent → cancelled, after PayPal cancelled the invoice.
export function markCancelled(db: Db, ownerProjectId: string, changeOrderId: string) {
  return db
    .update(changeOrders)
    .set({ status: "cancelled" })
    .where(and(owned(ownerProjectId, changeOrderId), eq(changeOrders.status, "sent")));
}

// What settling a payment needs: the order's status, amount and invoice id, and where it lives.
export interface PayableOrder extends PaymentOrder {
  projectId: string;
  sentAt: string | null;
}

const payableColumns = {
  id: changeOrders.id,
  status: changeOrders.status,
  amountCents: changeOrders.amountCents,
  paypalInvoiceId: changeOrders.paypalInvoiceId,
  projectId: changeOrders.projectId,
  sentAt: changeOrders.sentAt,
};

// Webhook only: any copy. paypal_invoice_id is UNIQUE, so at most one order matches.
export async function findOrderByInvoiceId(db: Db, invoiceId: string): Promise<PayableOrder | null> {
  const [row] = await db.select(payableColumns).from(changeOrders).where(eq(changeOrders.paypalInvoiceId, invoiceId));
  return row ?? null;
}

// "Check payment": only through the owner's project id.
export async function readPayableOrder(db: Db, ownerProjectId: string, changeOrderId: string): Promise<PayableOrder | null> {
  const [row] = await db.select(payableColumns).from(changeOrders).where(owned(ownerProjectId, changeOrderId));
  return row ?? null;
}

// sent → paid for this invoice. paid_at = max(?, sent_at), so the CHECK (paid_at >= sent_at) holds even if the
// server clock went back.
export function markPaid(db: Db, order: Pick<PayableOrder, "id" | "projectId">, invoiceId: string, paidAt: string) {
  return db
    .update(changeOrders)
    .set({ status: "paid", paidAt: sql`max(${paidAt}, ${changeOrders.sentAt})` })
    .where(and(owned(order.projectId, order.id), eq(changeOrders.status, "sent"), eq(changeOrders.paypalInvoiceId, invoiceId)));
}

// draft → sent → paid in one UPDATE, for a draft that already holds this invoice id: the app stopped between sending
// and saving sent, and the client paid. Clears the send claim; keeps a payer link already stored.
export function markPaidFromDraft(db: Db, order: Pick<PayableOrder, "id" | "projectId">, invoiceId: string, at: string, payerViewUrl: string | null) {
  return db
    .update(changeOrders)
    .set({ status: "paid", sentAt: at, paidAt: at, payerViewUrl: sql`coalesce(${changeOrders.payerViewUrl}, ${payerViewUrl})`, sendClaimedAt: null })
    .where(and(owned(order.projectId, order.id), eq(changeOrders.status, "draft"), eq(changeOrders.paypalInvoiceId, invoiceId)));
}
