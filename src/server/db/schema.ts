import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
// Relative import: drizzle-kit loads this file without the "@/" path alias.
import { CHANGE_ORDER_STATUSES } from "../../domain/types";

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
  },
  (t) => [
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
    // Mirrors the domain rules in change-order.ts, so a stray write can't skip them.
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

// PayPal event ids already handled, so a redelivered webhook changes nothing.
export const webhookEvents = sqliteTable("webhook_events", {
  id: text().primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
});
