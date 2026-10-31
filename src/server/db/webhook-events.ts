import { eq } from "drizzle-orm";
import type { WebhookOutcome } from "../../domain/webhook";
import type { Db } from "./client";
import { webhookEvents } from "./schema";

// PayPal webhook events already handled. The event id is the primary key, so recording the same event twice fails,
// and the batch that carried the second record (with any change it would have made) rolls back whole.

export interface WebhookEventRow {
  id: string; // PayPal event id ("WH-…"), the primary key
  eventType: string;
  invoiceId: string | null;
  outcome: WebhookOutcome;
  eventCreatedAt: string | null; // the event's create_time, kept to measure delivery lag (P3 (c))
  receivedAt: string; // also written to processed_at: an event is recorded only when it was handled
}

// A batch item. A second row with the same id makes the whole batch fail (isUniqueViolation → duplicate).
export function insertWebhookEvent(db: Db, row: WebhookEventRow) {
  return db.insert(webhookEvents).values({ ...row, processedAt: row.receivedAt });
}

export async function hasWebhookEvent(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.id, id));
  return row !== undefined;
}

// Corrects the outcome of an event already recorded, when what its batch did turns out different (P3-C2).
export async function setWebhookOutcome(db: Db, id: string, outcome: WebhookOutcome): Promise<void> {
  await db.update(webhookEvents).set({ outcome }).where(eq(webhookEvents.id, id));
}
