CREATE TABLE IF NOT EXISTS "rag_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "rag_project_id" uuid,
  ADD COLUMN IF NOT EXISTS "source_type" text DEFAULT 'general' NOT NULL;

DO $$ BEGIN
  ALTER TABLE "documents"
    ADD CONSTRAINT "documents_rag_project_id_rag_projects_id_fk"
    FOREIGN KEY ("rag_project_id") REFERENCES "rag_projects"("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "integration_configs" (
  "key" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "base_url" text,
  "username" text,
  "encrypted_token" text,
  "project_key" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
