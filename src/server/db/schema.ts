import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
// Relative import: drizzle-kit loads this file without the "@/" path alias.
import { CHANGE_ORDER_STATUSES } from "../../domain/types";

export const projects = sqliteTable("projects", {
  id: text().primaryKey(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email").notNull(),
  title: text().notNull(),
  hourlyRateCents: integer("hourly_rate_cents").notNull(),
  hoursPerDay: integer("hours_per_day").notNull(),
  agreedOn: text("agreed_on").notNull(),
  dueOn: text("due_on").notNull(),
  createdAt: text("created_at").notNull(),
});

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
  (t) => [index("scope_items_project_idx").on(t.projectId)],
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
    title: text().notNull(),
    estimatedHours: real("estimated_hours").notNull(),
    reason: text().notNull(),
  },
  (t) => [index("findings_message_idx").on(t.messageId)],
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
      .unique()
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
  (t) => [index("change_orders_project_idx").on(t.projectId)],
);

// PayPal event ids already handled, so a redelivered webhook changes nothing.
export const webhookEvents = sqliteTable("webhook_events", {
  id: text().primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
});
