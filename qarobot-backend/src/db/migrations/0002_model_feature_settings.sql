CREATE TABLE IF NOT EXISTS "model_feature_settings" (
	"feature_key" text PRIMARY KEY NOT NULL,
	"model_config_id" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_feature_settings" ADD CONSTRAINT "model_feature_settings_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
