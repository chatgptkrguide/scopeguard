import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
// Relative imports: drizzle-kit loads this file without the "@/" path alias.
import type { ActivityActor, ActivityDetail, ActivityKind } from "../../domain/activity";
import { CHANGE_ORDER_STATUSES } from "../../domain/types";
import type { WebhookOutcome } from "../../domain/webhook";

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey(),
    clientName: text("client_name").notNull(),
    clientEmail: text("client_email").notNull(),
    title: text().notNull(),
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    hoursPerDay: integer("hours_per_day").notNull(),
    agreedOn: text("agreed_on").notNull(),
    dueOn: text("due_on").notNull(),
    createdAt: text("created_at").notNull(),
    // Last time the visitor opened or reset this copy; copies unused for seven days are deleted.
    // The empty default exists only so SQLite can add the column to a table that already has rows
    // (migration 0001 then copies created_at into it). Every write sets a real time; see DemoRows.
    lastSeenAt: text("last_seen_at").notNull().default(""),
  },
  (t) => [
    // Cleanup looks up copies by last use every time a new copy is made.
    index("projects_last_seen_idx").on(t.lastSeenAt),
    check("projects_rate_positive", sql`${t.hourlyRateCents} > 0`),
    check("projects_hours_per_day_positive", sql`${t.hoursPerDay} > 0`),
  ],
);

export const scopeItems = sqliteTable(
  "scope_items",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text().notNull(),
    amountCents: integer("amount_cents").notNull(),
    position: integer().notNull(),
  },
  (t) => [
    index("scope_items_project_idx").on(t.projectId),
    check("scope_items_amount_not_negative", sql`${t.amountCents} >= 0`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    from: text("from_party", { enum: ["client", "me"] }).notNull(),
    author: text().notNull(),
    sentAt: text("sent_at").notNull(),
    body: text().notNull(),
  },
  (t) => [index("messages_project_idx").on(t.projectId, t.sentAt)],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text().primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    quote: text().notNull(),
    // Where the quote sits in the message body (UTF-16 offsets, as JavaScript slices them).
    quoteStart: integer("quote_start").notNull(),
    quoteEnd: integer("quote_end").notNull(),
    title: text().notNull(),
    estimatedHours: real("estimated_hours").notNull(),
    reason: text().notNull(),
  },
  (t) => [
    index("findings_message_idx").on(t.messageId),
    check("findings_hours_in_range", sql`${t.estimatedHours} > 0 AND ${t.estimatedHours} <= 200`),
    check("findings_quote_span", sql`${t.quoteStart} >= 0 AND ${t.quoteEnd} > ${t.quoteStart}`),
  ],
);

export const changeOrders = sqliteTable(
  "change_orders",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    title: text().notNull(),
    hours: real().notNull(),
    amountCents: integer("amount_cents").notNull(),
    extraDays: integer("extra_days").notNull(),
    status: text({ enum: CHANGE_ORDER_STATUSES }).notNull(),
    paypalInvoiceId: text("paypal_invoice_id").unique(),
    payerViewUrl: text("payer_view_url"),
    sentAt: text("sent_at"),
    paidAt: text("paid_at"),
    // When a send started (ISO). A second send of the same order stops while this is under two minutes old,
    // so it never reaches PayPal. Bookkeeping only: not part of ChangeOrder and never shown.
    sendClaimedAt: text("send_claimed_at"),
  },
  (t) => [
    index("change_orders_project_idx").on(t.projectId),
    // One live change order per finding; a cancelled one can be quoted again.
    uniqueIndex("change_orders_live_finding_idx").on(t.findingId).where(sql`${t.status} <> 'cancelled'`),
    check(
      "change_orders_status_known",
      sql.raw(`status IN (${CHANGE_ORDER_STATUSES.map((s) => `'${s}'`).join(", ")})`),
    ),
    check("change_orders_amount_not_negative", sql`${t.amountCents} >= 0`),
    check("change_orders_hours_positive", sql`${t.hours} > 0 AND ${t.extraDays} >= 0`),
    // What each status must hold. The only copy of these rules: the moves between statuses are in domain/change-order.ts.
    check(
      "change_orders_sent_has_invoice",
      sql`${t.status} <> 'sent' OR (${t.paypalInvoiceId} IS NOT NULL AND ${t.sentAt} IS NOT NULL)`,
    ),
    check(
      "change_orders_paid_has_dates",
      sql`${t.status} <> 'paid' OR (${t.paidAt} IS NOT NULL AND ${t.sentAt} IS NOT NULL AND ${t.paidAt} >= ${t.sentAt})`,
    ),
    check("change_orders_billed_amount_positive", sql`${t.status} NOT IN ('sent', 'paid') OR ${t.amountCents} > 0`),
  ],
);

// PayPal event ids already handled, so a redelivered webhook changes nothing. A row is written in the same batch as
// the change it caused, so it also means "handled" (processed_at = received_at). The three later columns were added
// by migration 0004 and are NULL on rows from before it.
export const webhookEvents = sqliteTable("webhook_events", {
  id: text().primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
  invoiceId: text("invoice_id"),
  outcome: text().$type<WebhookOutcome>(),
  // The event's create_time, kept to measure how late PayPal delivered it.
  eventCreatedAt: text("event_created_at"),
});

// Every PayPal send the server let through, for the server-wide cap (P2-S1, P2-S1b). No foreign key on purpose: a demo
// reset or the seven-day cleanup deletes the copy's orders, and the count must stay. Rows older than a day are pruned.
export const paypalSends = sqliteTable(
  "paypal_sends",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    changeOrderId: text("change_order_id").notNull(),
    at: text().notNull(),
  },
  (t) => [index("paypal_sends_at_idx").on(t.at)],
);

// The steps shown in the activity panel, written in the same batch as the change they describe.
// No CHECK on kind or actor: later phases add kinds, and SQLite can only change a CHECK by rebuilding the table.
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    changeOrderId: text("change_order_id").references(() => changeOrders.id, { onDelete: "cascade" }),
    kind: text().$type<ActivityKind>().notNull(),
    actor: text().$type<ActivityActor>().notNull(),
    summary: text().notNull(),
    detail: text({ mode: "json" }).$type<ActivityDetail>(),
    at: text().notNull(),
  },
  (t) => [index("activity_events_project_idx").on(t.projectId, t.id)],
);
