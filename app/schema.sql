CREATE TABLE `activity` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	`answers` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,
	`answer` text NOT NULL,
	`correct` integer NOT NULL,
	`duration` integer NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_user_time` ON `attempts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `completions` (
	`user_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `lesson_id`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`text` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`target` integer DEFAULT 800 NOT NULL,
	`minutes` integer DEFAULT 30 NOT NULL,
	`level` text DEFAULT 'A1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`user_id` text NOT NULL,
	`word_id` text NOT NULL,
	`interval_days` integer NOT NULL,
	`ease` real NOT NULL,
	`repetitions` integer NOT NULL,
	`due_at` integer NOT NULL,
	`lapses` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `word_id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`correct` integer NOT NULL,
	`total` integer NOT NULL,
	`seconds` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tests_user` ON `tests` (`user_id`,`created_at`);