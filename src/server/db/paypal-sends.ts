import { lte, sql } from "drizzle-orm";
import { SEND_LIMITS, type SendLimit } from "../../domain/send-limit";
import type { Db } from "./client";
import { paypalSends } from "./schema";

// The server-wide send cap, counted in its own table (P2-S1, P2-S1b). A demo reset and the seven-day cleanup delete a
// copy's orders and activity but never this table, and it outlives a restart. One row is one send that reached
// PayPal (a Send again counts too).

// Takes one place under every limit, or answers false and records nothing. One batch: prune rows older than the
// longest window, then a single INSERT … SELECT … WHERE (count in each window) < max. SQLite runs one write at a time,
// so two requests (or two processes on the same file) can't both take the last place. A row counts in a window
// while its time is after `at - windowMs`.
export async function takePayPalSend(db: Db, changeOrderId: string, at: Date, limits: readonly SendLimit[] = SEND_LIMITS): Promise<boolean> {
  const now = at.getTime();
  const since = (windowMs: number) => new Date(now - windowMs).toISOString();
  const longestWindowMs = Math.max(...limits.map((limit) => limit.windowMs));
  const roomInEveryWindow = sql.join(
    limits.map((limit) => sql`(SELECT count(*) FROM ${paypalSends} WHERE ${paypalSends.at} > ${since(limit.windowMs)}) < ${limit.max}`),
    sql` AND `,
  );
  const [, taken] = await db.batch([
    db.delete(paypalSends).where(lte(paypalSends.at, since(longestWindowMs))),
    db.run(sql`INSERT INTO ${paypalSends} (change_order_id, at) SELECT ${changeOrderId}, ${at.toISOString()} WHERE ${roomInEveryWindow}`),
  ]);
  return taken.rowsAffected > 0;
}
