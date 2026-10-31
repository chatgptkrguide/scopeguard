import { and, asc, countDistinct, eq, gte, inArray, sql } from "drizzle-orm";
import type { ActivityEvent, NewActivityEvent } from "../../domain/activity";
import type { Db } from "./client";
import { activityEvents } from "./schema";

// Activity rows are written next to the change they describe, in the same db.batch(), so one never lands
// without the other. Reads always filter by project, so a copy never sees another copy's steps.

// An insert to put in a batch.
export function activityInsert(db: Db, event: NewActivityEvent) {
  return db.insert(activityEvents).values(event);
}

// An insert that lands only if the statement just before it in the same batch changed a row (SQLite's
// changes()). A guarded UPDATE that found nothing to change, because another request got there first or the
// order moved on, then leaves no step behind for a change that didn't happen.
export function activityInsertAfterChange(db: Db, event: NewActivityEvent) {
  const detail = event.detail === null ? null : JSON.stringify(event.detail);
  return db.run(sql`
    INSERT INTO ${activityEvents} (project_id, change_order_id, kind, actor, summary, detail, at)
    SELECT ${event.projectId}, ${event.changeOrderId}, ${event.kind}, ${event.actor}, ${event.summary}, ${detail}, ${event.at}
    WHERE changes() > 0
  `);
}

// How many change orders, across every copy, got an invoice created or sent since a time: the part of the
// server-wide send cap that survives a restart (P2-S1). A demo reset deletes its copy's rows, so the server
// process keeps its own count too (domain/send-limit.ts).
export async function countSendsSince(db: Db, since: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(activityEvents.changeOrderId) })
    .from(activityEvents)
    .where(and(inArray(activityEvents.kind, ["invoice_created", "invoice_sent"]), gte(activityEvents.at, since)));
  return row?.n ?? 0;
}

// One copy's steps, oldest first.
export async function listActivity(db: Db, projectId: string): Promise<ActivityEvent[]> {
  const rows = await db.select().from(activityEvents).where(eq(activityEvents.projectId, projectId)).orderBy(asc(activityEvents.id));
  return rows.map((row) => ({ ...row }));
}
