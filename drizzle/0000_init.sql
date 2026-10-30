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
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_orders_finding_id_unique` ON `change_orders` (`finding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_orders_paypal_invoice_id_unique` ON `change_orders` (`paypal_invoice_id`);--> statement-breakpoint
CREATE INDEX `change_orders_project_idx` ON `change_orders` (`project_id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`quote` text NOT NULL,
	`title` text NOT NULL,
	`estimated_hours` real NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
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
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scope_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scope_items_project_idx` ON `scope_items` (`project_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
);
