import { and, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "../db/client.js";
import { modelConfigs, modelFeatureSettings } from "../db/schema.js";
import { decryptSecret } from "../lib/encryption.js";

export type TaskType = "planning" | "generation" | "scripting" | "healing";
export type FeatureKey = "document_chat" | "test_plan_generator" | "test_case_generator" | "test_script_generator" | "test_healer";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ModelConfig = InferSelectModel<typeof modelConfigs>;

export async function generateWithSelectedModel(
  taskType: TaskType,
  messages: ChatMessage[],
  options: { modelConfigId?: string } = {},
) {
  const model = options.modelConfigId ? await getModelById(options.modelConfigId) : await getActiveModel(taskType);

  if (!model) {
    throw new Error(
      options.modelConfigId
        ? "Selected model configuration was not found."
        : `No active ${taskType} model is configured. Configure one in the Models page.`,
    );
  }

  return generateWithModel(model, messages);
}

export async function generateWithFeatureModel(featureKey: FeatureKey, messages: ChatMessage[], options: { maxTokens?: number } = {}) {
  const model = await getFeatureModel(featureKey);

  if (!model) {
    throw new Error(featureMissingModelMessage(featureKey));
  }

  return generateWithModel(model, messages, options);
}

export async function testFeatureModelConnection(featureKey: FeatureKey) {
  const model = await getFeatureModel(featureKey);

  if (!model) {
    throw new Error(featureMissingModelMessage(featureKey));
  }

  const response = await generateWithModel(
    model,
    [
      { role: "system", content: "Reply with exactly OK." },
      { role: "user", content: "Connection test" },
    ],
    { maxTokens: 8 },
  );

  return {
    ok: true,
    providerName: model.providerName,
    modelName: model.modelName,
    taskType: model.taskType,
    note: `Feature model connection succeeded. Response: ${response.slice(0, 80)}`,
  };
}

export function featureMissingModelMessage(featureKey: FeatureKey) {
  if (featureKey === "document_chat") {
    return "No model is selected for Document Chat. Select one in Models -> Feature Model Selection.";
  }

  if (featureKey === "test_plan_generator") {
    return "No model is selected for Test Plan Generator. Select one in Models -> Feature Model Selection.";
  }

  if (featureKey === "test_case_generator") {
    return "No model is selected for Test Case Generator. Select one in Models -> Feature Model Selection.";
  }

  if (featureKey === "test_script_generator") {
    return "No model is selected for Test Script Generator. Select one in Models -> Feature Model Selection.";
  }

  if (featureKey === "test_healer") {
    return "No model is selected for Test Healer. Select one in Models -> Feature Model Selection.";
  }

  return `No model is selected for ${featureKey}.`;
}

export async function testModelConnectionById(id: string) {
  const model = await getModelById(id);

  if (!model) {
    throw new Error("Model configuration not found.");
  }

  const response = await generateWithModel(
    model,
    [
      { role: "system", content: "Reply with exactly OK." },
      { role: "user", content: "Connection test" },
    ],
    { maxTokens: 8 },
  );

  return {
    ok: true,
    providerName: model.providerName,
    modelName: model.modelName,
    taskType: model.taskType,
    note: `Live provider connection succeeded. Response: ${response.slice(0, 80)}`,
  };
}

export async function testActiveModelConnection(taskType: TaskType) {
  const model = await getActiveModel(taskType);

  if (!model) {
    throw new Error(`No active ${taskType} model is configured.`);
  }

  return testModelConnectionById(model.id);
}

async function generateWithModel(
  model: ModelConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
) {
  const provider = model.providerName.toLowerCase();

  if (provider === "openai") {
    return callOpenAiCompatible({
      apiKey: requireApiKey(model.encryptedApiKey),
      baseUrl: "https://api.openai.com/v1",
      modelName: model.modelName,
      messages,
      maxTokens: options.maxTokens,
    });
  }

  if (provider === "groq") {
    return callOpenAiCompatible({
      apiKey: requireApiKey(model.encryptedApiKey),
      baseUrl: "https://api.groq.com/openai/v1",
      modelName: model.modelName,
      messages,
      maxTokens: options.maxTokens,
    });
  }

  if (provider === "ollama") {
    return callOllama({
      baseUrl: model.baseUrl || "http://localhost:11434",
      modelName: model.modelName,
      messages,
      maxTokens: options.maxTokens,
    });
  }

  throw new Error(`${model.providerName} is stored but not wired for generation yet.`);
}

async function getModelById(id: string) {
  const [model] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);
  return model;
}

async function getFeatureModel(featureKey: FeatureKey) {
  const [row] = await db
    .select({ model: modelConfigs })
    .from(modelFeatureSettings)
    .innerJoin(modelConfigs, eq(modelFeatureSettings.modelConfigId, modelConfigs.id))
    .where(eq(modelFeatureSettings.featureKey, featureKey))
    .limit(1);

  return row?.model;
}

async function getActiveModel(taskType: TaskType) {
  const [model] = await db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.taskType, taskType), eq(modelConfigs.isActive, true)))
    .limit(1);

  return model;
}

function requireApiKey(encryptedApiKey: string | null) {
  if (!encryptedApiKey) {
    throw new Error("Selected model is missing an API key.");
  }

  return decryptSecret(encryptedApiKey);
}

async function callOpenAiCompatible(params: {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  messages: ChatMessage[];
  maxTokens?: number;
}) {
  const response = await fetch(`${params.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.modelName,
      messages: params.messages,
      temperature: 0.2,
      max_tokens: params.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned an empty response.");
  }

  return content;
}

async function callOllama(params: {
  baseUrl: string;
  modelName: string;
  messages: ChatMessage[];
  maxTokens?: number;
}) {
  const response = await fetch(`${params.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.modelName,
      messages: params.messages,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: params.maxTokens,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  if (!data.message?.content) {
    throw new Error("Ollama returned an empty response.");
  }

  return data.message.content;
}
