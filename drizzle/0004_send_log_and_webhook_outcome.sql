CREATE TABLE `paypal_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`change_order_id` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `paypal_sends_at_idx` ON `paypal_sends` (`at`);--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `invoice_id` text;--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `event_created_at` text;