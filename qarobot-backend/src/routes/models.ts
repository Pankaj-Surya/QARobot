import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { modelConfigs, modelFeatureSettings } from "../db/schema.js";
import { encryptSecret } from "../lib/encryption.js";
import {
  testActiveModelConnection,
  testModelConnectionById,
  type TaskType,
} from "../services/ai-adapter.js";

const configureModelSchema = z.object({
  providerName: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional().or(z.literal("")),
  modelName: z.string().min(1),
  taskType: z.enum(["planning", "generation", "scripting", "healing"]),
  isActive: z.boolean().optional().default(true),
});

const testModelSchema = z.object({
  id: z.string().uuid().optional(),
  taskType: z.enum(["planning", "generation", "scripting", "healing"]).optional(),
});

const featureSettingSchema = z.object({
  modelConfigId: z.string().uuid(),
});

const featureKeySchema = z.enum(["document_chat", "test_plan_generator", "test_case_generator", "test_script_generator", "test_healer"]);

export async function modelsRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await db
      .select({
        id: modelConfigs.id,
        providerName: modelConfigs.providerName,
        encryptedApiKey: modelConfigs.encryptedApiKey,
        baseUrl: modelConfigs.baseUrl,
        modelName: modelConfigs.modelName,
        taskType: modelConfigs.taskType,
        isActive: modelConfigs.isActive,
        createdAt: modelConfigs.createdAt,
      })
      .from(modelConfigs)
      .orderBy(desc(modelConfigs.createdAt));

    return {
      models: rows.map(({ encryptedApiKey, ...model }) => ({
        ...model,
        hasApiKey: Boolean(encryptedApiKey),
      })),
    };
  });

  app.post("/configure", async (request, reply) => {
    const parsed = configureModelSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid model configuration",
        details: parsed.error.flatten(),
      });
    }

    const config = parsed.data;

    if (config.providerName.toLowerCase() === "ollama" && !config.baseUrl) {
      return reply.code(400).send({ error: "Ollama configuration requires baseUrl." });
    }

    if (config.providerName.toLowerCase() !== "ollama" && !config.apiKey) {
      return reply.code(400).send({ error: "API key is required for this provider." });
    }

    if (config.isActive) {
      await db
        .update(modelConfigs)
        .set({ isActive: false })
        .where(eq(modelConfigs.taskType, config.taskType));
    }

    const [model] = await db
      .insert(modelConfigs)
      .values({
        providerName: config.providerName,
        encryptedApiKey: config.apiKey ? encryptSecret(config.apiKey) : null,
        baseUrl: config.baseUrl || null,
        modelName: config.modelName,
        taskType: config.taskType,
        isActive: config.isActive,
      })
      .returning();

    return reply.code(201).send({
      model: {
        ...model,
        encryptedApiKey: undefined,
        hasApiKey: Boolean(model.encryptedApiKey),
      },
    });
  });

  app.get("/feature-settings", async () => {
    const rows = await db
      .select({
        featureKey: modelFeatureSettings.featureKey,
        modelConfigId: modelFeatureSettings.modelConfigId,
        updatedAt: modelFeatureSettings.updatedAt,
        providerName: modelConfigs.providerName,
        modelName: modelConfigs.modelName,
        taskType: modelConfigs.taskType,
      })
      .from(modelFeatureSettings)
      .innerJoin(modelConfigs, eq(modelFeatureSettings.modelConfigId, modelConfigs.id))
      .orderBy(desc(modelFeatureSettings.updatedAt));

    return { settings: rows };
  });

  app.put("/feature-settings/:featureKey", async (request, reply) => {
    const featureKey = featureKeySchema.safeParse((request.params as { featureKey?: string }).featureKey);
    if (!featureKey.success) {
      return reply.code(400).send({ error: "Unsupported feature model setting." });
    }

    const parsed = featureSettingSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid feature model setting",
        details: parsed.error.flatten(),
      });
    }

    const [model] = await db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.id, parsed.data.modelConfigId))
      .limit(1);

    if (!model) {
      return reply.code(404).send({ error: "Model configuration not found" });
    }

    const [setting] = await db
      .insert(modelFeatureSettings)
      .values({
        featureKey: featureKey.data,
        modelConfigId: parsed.data.modelConfigId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: modelFeatureSettings.featureKey,
        set: {
          modelConfigId: parsed.data.modelConfigId,
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      setting: {
        ...setting,
        providerName: model.providerName,
        modelName: model.modelName,
        taskType: model.taskType,
      },
    };
  });

  app.post("/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [model] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);

    if (!model) {
      return reply.code(404).send({ error: "Model configuration not found" });
    }

    await db
      .update(modelConfigs)
      .set({ isActive: false })
      .where(eq(modelConfigs.taskType, model.taskType));

    const [updated] = await db
      .update(modelConfigs)
      .set({ isActive: true })
      .where(eq(modelConfigs.id, id))
      .returning();

    return {
      model: {
        ...updated,
        encryptedApiKey: undefined,
        hasApiKey: Boolean(updated.encryptedApiKey),
      },
    };
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [model] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);

    if (!model) {
      return reply.code(404).send({ error: "Model configuration not found" });
    }

    await db.delete(modelConfigs).where(eq(modelConfigs.id, id));

    return {
      ok: true,
      deletedModel: {
        id: model.id,
        providerName: model.providerName,
        modelName: model.modelName,
        taskType: model.taskType,
        wasActive: model.isActive,
      },
    };
  });

  app.post("/test", async (request, reply) => {
    const parsed = testModelSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid model test request",
        details: parsed.error.flatten(),
      });
    }

    try {
      const result = parsed.data.id
        ? await testModelConnectionById(parsed.data.id)
        : await testActiveModelConnection((parsed.data.taskType || "planning") as TaskType);

      return {
        ...result,
        status: "connected",
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Model connection test failed",
      });
    }
  });
}
