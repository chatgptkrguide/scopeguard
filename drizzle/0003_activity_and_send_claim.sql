CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`change_order_id` text,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`change_order_id`) REFERENCES `change_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_events_project_idx` ON `activity_events` (`project_id`,`id`);--> statement-breakpoint
ALTER TABLE `change_orders` ADD `send_claimed_at` text;