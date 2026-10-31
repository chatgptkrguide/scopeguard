"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/domain/action-result";
import { waiveOwnedChangeOrder } from "@/server/db/change-orders";
import { getDb } from "@/server/db/client";
import { resetDemoCopy } from "@/server/db/demo";
import { currentProjectId } from "@/server/session";

// Anyone can POST to these, so each one reads only the id it needs, checks it, and takes the owner
// from the visitor cookie. Amounts and statuses come from the database. `_prev` comes from the browser
// (useActionState) and is never used.

const changeOrderIdSchema = z.uuid();
const demoProjectIdSchema = z.string().regex(/^v_[A-Za-z0-9_-]{22}$/);

export async function waiveChangeOrder(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const changeOrderId = changeOrderIdSchema.safeParse(formData.get("changeOrderId"));
  if (!changeOrderId.success) return { ok: false, error: "invalid_input" };

  const ownerProjectId = await currentProjectId();
  if (!ownerProjectId) return { ok: false, error: "not_found" };

  let result: ActionResult;
  try {
    result = await waiveOwnedChangeOrder(getDb(), ownerProjectId, changeOrderId.data);
  } catch (error) {
    console.error("waiving a change order failed", error);
    return { ok: false, error: "server_error" };
  }
  if (result.ok) refresh();
  return result;
}

export async function resetDemo(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const projectId = demoProjectIdSchema.safeParse(formData.get("projectId"));
  if (!projectId.success) return { ok: false, error: "invalid_input" };

  // Someone else's copy and a copy that doesn't exist answer the same way.
  if (projectId.data !== (await currentProjectId())) return { ok: false, error: "not_found" };

  try {
    await resetDemoCopy(getDb(), projectId.data, new Date());
  } catch (error) {
    // The reset is one batch, so a failure leaves the copy exactly as it was.
    console.error("resetting the demo copy failed", error);
    return { ok: false, error: "server_error" };
  }
  refresh();
  return { ok: true };
}
