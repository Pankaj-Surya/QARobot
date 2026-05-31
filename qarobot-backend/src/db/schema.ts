import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const documentStatus = pgEnum("document_status", [
  "uploading",
  "processing",
  "indexed",
  "failed",
]);

export const healStatus = pgEnum("heal_status", [
  "pending",
  "approved",
  "rejected",
  "auto_healed",
]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "pending",
  "running",
  "passed",
  "failed",
  "cancelled",
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  r2Key: text("r2_key").notNull(),
  status: documentStatus("status").notNull().default("uploading"),
  errorMessage: text("error_message"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").references(() => documents.id).notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  chunkTextPreview: text("chunk_text_preview").notNull(),
  fullText: text("full_text").notNull(),
  vectorId: text("vector_id").notNull(),
  chunkKind: text("chunk_kind").notNull().default("paragraph"),
  sourceLocator: text("source_locator"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  tokenCount: integer("token_count").notNull().default(0),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const modelConfigs = pgTable("model_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerName: text("provider_name").notNull(),
  encryptedApiKey: text("encrypted_api_key"),
  baseUrl: text("base_url"),
  modelName: text("model_name").notNull(),
  taskType: text("task_type").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const modelFeatureSettings = pgTable("model_feature_settings", {
  featureKey: text("feature_key").primaryKey(),
  modelConfigId: uuid("model_config_id").references(() => modelConfigs.id, { onDelete: "cascade" }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const testPlans = pgTable("test_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scopeDescription: text("scope_description").notNull(),
  content: text("content").notNull(),
  aiModelUsed: text("ai_model_used"),
  sourceDocumentIds: jsonb("source_document_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const testCases = pgTable("test_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tcId: text("tc_id").notNull(),
  title: text("title").notNull(),
  module: text("module").notNull(),
  testType: text("test_type").notNull(),
  priority: text("priority").notNull(),
  preconditions: text("preconditions"),
  steps: jsonb("steps").$type<string[]>().notNull().default([]),
  testData: text("test_data"),
  expectedResult: text("expected_result").notNull(),
  automationStatus: text("automation_status").notNull().default("manual"),
  linkedPlanId: uuid("linked_plan_id").references(() => testPlans.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const testScripts = pgTable("test_scripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  framework: text("framework").notNull(),
  testCaseIds: jsonb("test_case_ids").$type<string[]>().notNull().default([]),
  files: jsonb("files").$type<Record<string, string>>().notNull(),
  appUrl: text("app_url"),
  inputMode: text("input_mode").notNull().default("saved"),
  manualTestCaseText: text("manual_test_case_text"),
  pageContext: jsonb("page_context").$type<unknown>(),
  generationWarnings: jsonb("generation_warnings").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const testRuns = pgTable("test_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  scriptId: uuid("script_id").references(() => testScripts.id),
  status: runStatus("status").notNull().default("pending"),
  browser: text("browser").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  totalTests: integer("total_tests").notNull().default(0),
  passedCount: integer("passed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  results: jsonb("results").$type<unknown>(),
  logUrl: text("log_url"),
});

export const runnerSettings = pgTable("runner_settings", {
  key: text("key").primaryKey().default("default"),
  mode: text("mode").notNull().default("disabled"),
  workerUrl: text("worker_url"),
  callbackBaseUrl: text("callback_base_url"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const healLogs = pgTable("heal_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  scriptId: uuid("script_id").references(() => testScripts.id).notNull(),
  testCaseId: uuid("test_case_id").references(() => testCases.id),
  brokenSelector: text("broken_selector").notNull(),
  suggestedSelector: text("suggested_selector"),
  confidenceScore: numeric("confidence_score"),
  screenshotUrl: text("screenshot_url"),
  status: healStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
