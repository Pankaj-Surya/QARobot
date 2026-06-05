import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { integrationConfigs, modelConfigs, modelFeatureSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
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
const integrationSchema = z.object({
  provider: z.enum(["jira", "azure_boards"]),
  baseUrl: z.string().url().optional().or(z.literal("")),
  username: z.string().optional().default(""),
  token: z.string().optional().default(""),
  projectKey: z.string().optional().default(""),
  metadata: z.record(z.unknown()).optional().default({}),
});

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

  app.get("/integrations", async () => {
    const rows = await db.select().from(integrationConfigs).orderBy(desc(integrationConfigs.updatedAt));
    return {
      integrations: rows.map(({ encryptedToken, ...row }) => ({
        ...row,
        hasToken: Boolean(encryptedToken),
      })),
    };
  });

  app.put("/integrations/:provider", async (request, reply) => {
    const provider = z.enum(["jira", "azure_boards"]).safeParse((request.params as { provider?: string }).provider);
    if (!provider.success) return reply.code(400).send({ error: "Unsupported integration provider." });

    const parsed = integrationSchema.safeParse({ ...(request.body as object), provider: provider.data });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid integration configuration", details: parsed.error.flatten() });
    }

    const existing = await db.select().from(integrationConfigs).where(eq(integrationConfigs.key, provider.data)).limit(1);
    const encryptedToken = parsed.data.token ? encryptSecret(parsed.data.token) : existing[0]?.encryptedToken || null;
    const [integration] = await db
      .insert(integrationConfigs)
      .values({
        key: provider.data,
        provider: provider.data,
        baseUrl: parsed.data.baseUrl || null,
        username: parsed.data.username || null,
        encryptedToken,
        projectKey: parsed.data.projectKey || null,
        metadata: parsed.data.metadata,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: integrationConfigs.key,
        set: {
          baseUrl: parsed.data.baseUrl || null,
          username: parsed.data.username || null,
          encryptedToken,
          projectKey: parsed.data.projectKey || null,
          metadata: parsed.data.metadata,
          updatedAt: new Date(),
        },
      })
      .returning();

    return { integration: { ...integration, encryptedToken: undefined, hasToken: Boolean(integration.encryptedToken) } };
  });

  app.post("/integrations/:provider/test", async (request, reply) => {
    const provider = z.enum(["jira", "azure_boards"]).safeParse((request.params as { provider?: string }).provider);
    if (!provider.success) return reply.code(400).send({ error: "Unsupported integration provider." });

    const [integration] = await db.select().from(integrationConfigs).where(eq(integrationConfigs.key, provider.data)).limit(1);
    if (!integration || !integration.baseUrl || !integration.encryptedToken) {
      return reply.code(400).send({ error: "Integration is not configured with a base URL and token." });
    }

    try {
      const token = decryptSecret(integration.encryptedToken);
      const result = await testIntegrationConnection(provider.data, integration.baseUrl, integration.username || "", token);
      return { status: "connected", ...result };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Integration connection failed." });
    }
  });

  app.post("/integrations/:provider/fetch-requirement", async (request, reply) => {
    const provider = z.enum(["jira", "azure_boards"]).safeParse((request.params as { provider?: string }).provider);
    if (!provider.success) return reply.code(400).send({ error: "Unsupported integration provider." });
    const parsed = z.object({ key: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Requirement key is required.", details: parsed.error.flatten() });

    const [integration] = await db.select().from(integrationConfigs).where(eq(integrationConfigs.key, provider.data)).limit(1);
    if (!integration || !integration.baseUrl || !integration.encryptedToken) {
      return reply.code(400).send({ error: "Integration is not configured with a base URL and token." });
    }

    try {
      const token = decryptSecret(integration.encryptedToken);
      const requirement = await fetchRequirement(provider.data, integration.baseUrl, integration.username || "", token, parsed.data.key);
      return { requirement };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Requirement fetch failed." });
    }
  });
}

async function testIntegrationConnection(provider: "jira" | "azure_boards", baseUrl: string, username: string, token: string) {
  const targetUrl = provider === "jira"
    ? `${baseUrl.replace(/\/$/, "")}/rest/api/3/myself`
    : `${baseUrl.replace(/\/$/, "")}/_apis/projects?api-version=7.1`;
  const headers: Record<string, string> = provider === "jira"
    ? { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`, accept: "application/json" }
    : { authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, accept: "application/json" };
  const response = await fetch(targetUrl, { headers });
  if (!response.ok) {
    throw new Error(`${provider === "jira" ? "Jira" : "Azure Boards"} connection failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return { provider, checkedUrl: targetUrl };
}

async function fetchRequirement(provider: "jira" | "azure_boards", baseUrl: string, username: string, token: string, key: string) {
  if (provider === "jira") {
    const targetUrl = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;
    const response = await fetch(targetUrl, {
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
        accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`Jira requirement fetch failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const json = await response.json() as { key?: string; fields?: { summary?: string; description?: unknown } };
    return {
      key: json.key || key,
      title: json.fields?.summary || key,
      text: `${json.fields?.summary || ""}\n${flattenAtlassianDoc(json.fields?.description)}`.trim(),
      provider,
    };
  }

  const targetUrl = `${baseUrl.replace(/\/$/, "")}/_apis/wit/workitems/${encodeURIComponent(key)}?api-version=7.1`;
  const response = await fetch(targetUrl, {
    headers: {
      authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Azure Boards requirement fetch failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = await response.json() as { id?: number; fields?: Record<string, unknown> };
  const title = String(json.fields?.["System.Title"] || key);
  const description = stripHtml(String(json.fields?.["System.Description"] || json.fields?.["Microsoft.VSTS.Common.AcceptanceCriteria"] || ""));
  return { key: String(json.id || key), title, text: `${title}\n${description}`.trim(), provider };
}

function flattenAtlassianDoc(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenAtlassianDoc).join("\n");
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return [row.text, flattenAtlassianDoc(row.content)].filter(Boolean).join("\n");
  }
  return String(value);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
