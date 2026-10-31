ALTER TABLE `projects` ADD `last_seen_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Rows that existed before this column count as last seen when they were created.
UPDATE `projects` SET `last_seen_at` = `created_at`;
