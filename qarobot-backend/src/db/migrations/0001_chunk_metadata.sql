ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "chunk_kind" text DEFAULT 'paragraph' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "source_locator" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "embedding_model" text;--> statement-breakpoint
