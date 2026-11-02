"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult, BillingActionResult, ResetActionResult } from "@/domain/action-result";
import { cancelOwnedChangeOrder, liveBillingDeps, requoteOwnedChangeOrder, sendOwnedChangeOrder } from "@/server/billing";
import { waiveOwnedChangeOrder } from "@/server/db/change-orders";
import { checkOwnedPayment } from "@/server/payments";
import { getDb } from "@/server/db/client";
import { resetDemoCopy } from "@/server/db/demo";
import { currentProjectId } from "@/server/session";

// Anyone can POST to these, so each one reads only the id it needs, checks it, and takes the owner
// from the visitor cookie. Amounts and statuses come from the database. `_prev` comes from the browser
// (useActionState) and is never used.

const changeOrderIdSchema = z.uuid();
const demoProjectIdSchema = z.string().regex(/^v_[A-Za-z0-9_-]{22}$/);

// A draft that already has a PayPal invoice is refused (invoice_exists); the page is refreshed then too, so the
// note shows "Send again" in place of the stale waive button.
export async function waiveChangeOrder(_prev: BillingActionResult | null, formData: FormData): Promise<BillingActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: BillingActionResult;
  try {
    result = await waiveOwnedChangeOrder(getDb(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("waiving a change order failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok || result.error === "invoice_exists") refresh();
  return result;
}

// Refused with invoice_open while a change order has an invoice the client may still pay: deleting that order would
// leave a payment the webhook can't record. The page is refreshed then too, so it shows the order as it is now.
export async function resetDemo(_prev: ResetActionResult | null, formData: FormData): Promise<ResetActionResult> {
  const projectId = demoProjectIdSchema.safeParse(formData.get("projectId"));
  if (!projectId.success) return { ok: false, error: "invalid_input" };

  // Someone else's copy and a copy that doesn't exist answer the same way.
  if (projectId.data !== (await currentProjectId())) return { ok: false, error: "not_found" };

  let outcome: "reset" | "invoice_open";
  try {
    outcome = await resetDemoCopy(getDb(), projectId.data, new Date());
  } catch (error) {
    // The reset is one batch, so a failure leaves the copy exactly as it was.
    console.error("resetting the demo copy failed", error);
    return { ok: false, error: "server_error" };
  }
  refresh();
  return outcome === "reset" ? { ok: true } : { ok: false, error: "invoice_open" };
}

// Sends the change order as a PayPal invoice. The form carries only the id: amount, client and invoice come
// from the database. PayPal failures come back as codes; their details stay in the server log and activity.
// paypal_unconfirmed and invoice_void refresh the page too: the draft now has an invoice, so the note offers Send
// again, or it was marked cancelled, so the note offers Quote again.
export async function sendChangeOrder(_prev: BillingActionResult | null, formData: FormData): Promise<BillingActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: BillingActionResult;
  try {
    result = await sendOwnedChangeOrder(liveBillingDeps(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("sending a change order failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok || result.error === "paypal_unconfirmed" || result.error === "invoice_void") refresh();
  return result;
}

// Cancels the sent change order's PayPal invoice, then marks it cancelled.
export async function cancelChangeOrder(_prev: BillingActionResult | null, formData: FormData): Promise<BillingActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: BillingActionResult;
  try {
    result = await cancelOwnedChangeOrder(liveBillingDeps(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("cancelling a change order failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok) refresh();
  return result;
}

// Quotes a cancelled change order's finding again, as a new draft priced from the rate. No PayPal call.
export async function requoteChangeOrder(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: ActionResult;
  try {
    result = await requoteOwnedChangeOrder(getDb(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("quoting a change order again failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok) refresh();
  return result;
}

// Reads the invoice from PayPal and marks the order paid if PayPal says so. Refreshes the page when it is paid.
export async function checkPayment(_prev: BillingActionResult | null, formData: FormData): Promise<BillingActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: BillingActionResult;
  try {
    result = await checkOwnedPayment(liveBillingDeps(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("checking a payment failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok) refresh();
  return result;
}
