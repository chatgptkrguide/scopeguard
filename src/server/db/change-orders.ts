import { and, eq } from "drizzle-orm";
import type { ActionResult } from "../../domain/action-result";
import { canTransition } from "../../domain/change-order";
import type { Db } from "./client";
import { changeOrders } from "./schema";

// Change order commands. Each one reads the order only through its owner's project id,
// so another copy's order looks exactly like one that doesn't exist.

function owned(ownerProjectId: string, changeOrderId: string) {
  return and(eq(changeOrders.id, changeOrderId), eq(changeOrders.projectId, ownerProjectId));
}

async function ownedStatus(db: Db, ownerProjectId: string, changeOrderId: string) {
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
