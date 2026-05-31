CREATE TYPE "public"."document_status" AS ENUM('uploading', 'processing', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."heal_status" AS ENUM('pending', 'approved', 'rejected', 'auto_healed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'passed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_text_preview" text NOT NULL,
	"full_text" text NOT NULL,
	"vector_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"r2_key" text NOT NULL,
	"status" "document_status" DEFAULT 'uploading' NOT NULL,
	"error_message" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "heal_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"test_case_id" uuid,
	"broken_selector" text NOT NULL,
	"suggested_selector" text,
	"confidence_score" numeric,
	"screenshot_url" text,
	"status" "heal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"encrypted_api_key" text,
	"base_url" text,
	"model_name" text NOT NULL,
	"task_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tc_id" text NOT NULL,
	"title" text NOT NULL,
	"module" text NOT NULL,
	"test_type" text NOT NULL,
	"priority" text NOT NULL,
	"preconditions" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"test_data" text,
	"expected_result" text NOT NULL,
	"automation_status" text DEFAULT 'manual' NOT NULL,
	"linked_plan_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope_description" text NOT NULL,
	"content" text NOT NULL,
	"ai_model_used" text,
	"source_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"browser" text NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"total_tests" integer DEFAULT 0 NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"results" jsonb,
	"log_url" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"framework" text NOT NULL,
	"test_case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heal_logs" ADD CONSTRAINT "heal_logs_script_id_test_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."test_scripts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heal_logs" ADD CONSTRAINT "heal_logs_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_linked_plan_id_test_plans_id_fk" FOREIGN KEY ("linked_plan_id") REFERENCES "public"."test_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_script_id_test_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."test_scripts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
