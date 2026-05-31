ALTER TABLE "test_scripts" ADD COLUMN "app_url" text;--> statement-breakpoint
ALTER TABLE "test_scripts" ADD COLUMN "input_mode" text DEFAULT 'saved' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_scripts" ADD COLUMN "manual_test_case_text" text;--> statement-breakpoint
ALTER TABLE "test_scripts" ADD COLUMN "page_context" jsonb;--> statement-breakpoint
ALTER TABLE "test_scripts" ADD COLUMN "generation_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;
