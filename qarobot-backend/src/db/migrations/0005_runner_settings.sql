CREATE TABLE IF NOT EXISTS "runner_settings" (
	"key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"mode" text DEFAULT 'disabled' NOT NULL,
	"worker_url" text,
	"callback_base_url" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
