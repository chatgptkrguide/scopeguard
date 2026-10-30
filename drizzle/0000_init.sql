CREATE TABLE `change_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`title` text NOT NULL,
	`hours` real NOT NULL,
	`amount_cents` integer NOT NULL,
	`extra_days` integer NOT NULL,
	`status` text NOT NULL,
	`paypal_invoice_id` text,
	`payer_view_url` text,
	`sent_at` text,
	`paid_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "change_orders_status_known" CHECK(status IN ('draft', 'sent', 'paid', 'waived', 'cancelled')),
	CONSTRAINT "change_orders_amount_not_negative" CHECK("change_orders"."amount_cents" >= 0),
	CONSTRAINT "change_orders_hours_positive" CHECK("change_orders"."hours" > 0 AND "change_orders"."extra_days" >= 0),
	CONSTRAINT "change_orders_sent_has_invoice" CHECK("change_orders"."status" <> 'sent' OR ("change_orders"."paypal_invoice_id" IS NOT NULL AND "change_orders"."sent_at" IS NOT NULL)),
	CONSTRAINT "change_orders_paid_has_dates" CHECK("change_orders"."status" <> 'paid' OR ("change_orders"."paid_at" IS NOT NULL AND "change_orders"."sent_at" IS NOT NULL AND "change_orders"."paid_at" >= "change_orders"."sent_at")),
	CONSTRAINT "change_orders_billed_amount_positive" CHECK("change_orders"."status" NOT IN ('sent', 'paid') OR "change_orders"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_orders_paypal_invoice_id_unique` ON `change_orders` (`paypal_invoice_id`);--> statement-breakpoint
CREATE INDEX `change_orders_project_idx` ON `change_orders` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_orders_live_finding_idx` ON `change_orders` (`finding_id`) WHERE "change_orders"."status" <> 'cancelled';--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`quote` text NOT NULL,
	`quote_start` integer NOT NULL,
	`quote_end` integer NOT NULL,
	`title` text NOT NULL,
	`estimated_hours` real NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "findings_hours_in_range" CHECK("findings"."estimated_hours" > 0 AND "findings"."estimated_hours" <= 200),
	CONSTRAINT "findings_quote_span" CHECK("findings"."quote_start" >= 0 AND "findings"."quote_end" > "findings"."quote_start")
);
--> statement-breakpoint
CREATE INDEX `findings_message_idx` ON `findings` (`message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_party` text NOT NULL,
	`author` text NOT NULL,
	`sent_at` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_project_idx` ON `messages` (`project_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`client_email` text NOT NULL,
	`title` text NOT NULL,
	`hourly_rate_cents` integer NOT NULL,
	`hours_per_day` integer NOT NULL,
	`agreed_on` text NOT NULL,
	`due_on` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "projects_rate_positive" CHECK("projects"."hourly_rate_cents" > 0),
	CONSTRAINT "projects_hours_per_day_positive" CHECK("projects"."hours_per_day" > 0)
);
--> statement-breakpoint
CREATE TABLE `scope_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scope_items_amount_not_negative" CHECK("scope_items"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `scope_items_project_idx` ON `scope_items` (`project_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
);
