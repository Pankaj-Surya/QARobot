"use client";

import { AppShell } from "@/components/app-shell";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api-client";
import { CheckCircle2, KeyRound, LoaderCircle, PlugZap, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const providers = [
  { name: "OpenAI", model: "gpt-4o-mini" },
  { name: "Anthropic", model: "claude-3-5-sonnet-latest" },
  { name: "Google", model: "gemini-1.5-flash" },
  { name: "Groq", model: "llama-3.3-70b-versatile" },
  { name: "Ollama", model: "llama3.1" },
];

const taskTypes = ["planning", "generation", "scripting", "healing"] as const;

type TaskType = (typeof taskTypes)[number];

type ModelConfig = {
  id: string;
  providerName: string;
  baseUrl: string | null;
  modelName: string;
  taskType: TaskType;
  isActive: boolean;
  createdAt: string;
  hasApiKey: boolean;
};

type FeatureSetting = {
  featureKey: FeatureKey;
  modelConfigId: string;
  updatedAt: string;
  providerName: string;
  modelName: string;
  taskType: TaskType;
};

type FeatureKey = "document_chat" | "test_plan_generator" | "test_case_generator" | "test_script_generator";

const featureOptions: Array<{ key: FeatureKey; label: string }> = [
  { key: "document_chat", label: "Document Chat" },
  { key: "test_plan_generator", label: "Test Plan Generator" },
  { key: "test_case_generator", label: "Test Case Generator" },
  { key: "test_script_generator", label: "Test Script Generator" },
];

export default function ModelsPage() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [featureSettings, setFeatureSettings] = useState<FeatureSetting[]>([]);
  const [providerName, setProviderName] = useState("OpenAI");
  const [modelName, setModelName] = useState(providers[0].model);
  const [taskType, setTaskType] = useState<TaskType>("planning");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [featureModelIds, setFeatureModelIds] = useState<Record<FeatureKey, string>>({
    document_chat: "",
    test_plan_generator: "",
    test_case_generator: "",
    test_script_generator: "",
  });
  const [savingFeatureKey, setSavingFeatureKey] = useState<FeatureKey | null>(null);

  const isOllama = providerName.toLowerCase() === "ollama";

  async function loadModels() {
    const [modelsResult, settingsResult] = await Promise.all([
      apiGet<{ models: ModelConfig[] }>("/api/models"),
      apiGet<{ settings: FeatureSetting[] }>("/api/models/feature-settings"),
    ]);
    setModels(modelsResult.models);
    setFeatureSettings(settingsResult.settings);
    setFeatureModelIds({
      document_chat: findFeatureModelId(settingsResult.settings, "document_chat"),
      test_plan_generator: findFeatureModelId(settingsResult.settings, "test_plan_generator"),
      test_case_generator: findFeatureModelId(settingsResult.settings, "test_case_generator"),
      test_script_generator: findFeatureModelId(settingsResult.settings, "test_script_generator"),
    });
  }

  useEffect(() => {
    loadModels().catch((loadError) => setError(readError(loadError)));
  }, []);

  async function saveModel() {
    setError(null);
    setMessage(null);
    setIsSaving(true);

    try {
      await apiPost("/api/models/configure", {
        providerName,
        modelName,
        taskType,
        apiKey: isOllama ? undefined : apiKey,
        baseUrl: isOllama ? baseUrl : undefined,
        isActive: true,
      });
      setApiKey("");
      setMessage(`${providerName} saved as the active ${taskType} model.`);
      await loadModels();
    } catch (saveError) {
      setError(readError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function testModel(id: string) {
    setError(null);
    setMessage(null);
    setTestingModelId(id);

    try {
      const result = await apiPost<{ ok: boolean; note: string; providerName: string; modelName: string; status: string }>(
        "/api/models/test",
        { id },
      );
      setMessage(`${result.providerName} ${result.modelName}: ${result.status}. ${result.note}`);
    } catch (testError) {
      setError(readError(testError));
    } finally {
      setTestingModelId(null);
    }
  }

  async function activateModel(id: string) {
    setError(null);
    setMessage(null);

    try {
      await apiPost(`/api/models/${id}/activate`, {});
      setMessage("Model activated for its task type.");
      await loadModels();
    } catch (activateError) {
      setError(readError(activateError));
    }
  }

  async function deleteModel(model: ModelConfig) {
    const confirmed = window.confirm(`Delete ${model.providerName} ${model.modelName} for ${model.taskType}?`);
    if (!confirmed) {
      return;
    }

    setError(null);
    setMessage(null);
    setDeletingModelId(model.id);

    try {
      await apiDelete(`/api/models/${model.id}`);
      setMessage(`${model.providerName} ${model.modelName} deleted.`);
      await loadModels();
    } catch (deleteError) {
      setError(readError(deleteError));
    } finally {
      setDeletingModelId(null);
    }
  }

  async function saveFeatureModel(featureKey: FeatureKey) {
    setError(null);
    setMessage(null);
    setSavingFeatureKey(featureKey);

    try {
      await apiPut(`/api/models/feature-settings/${featureKey}`, { modelConfigId: featureModelIds[featureKey] });
      setMessage(`${featureLabel(featureKey)} model selection saved.`);
      await loadModels();
    } catch (settingError) {
      setError(readError(settingError));
    } finally {
      setSavingFeatureKey(null);
    }
  }

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Model Connector</h1>
        <p className="mt-1 text-sm text-slate-500">Store provider credentials encrypted and assign defaults by task.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <KeyRound size={17} />
            Configure Provider
          </div>

          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Provider</span>
              <select
                className="w-full rounded-md border border-line px-3 py-2"
                value={providerName}
                onChange={(event) => {
                  const selected = providers.find((provider) => provider.name === event.target.value);
                  setProviderName(event.target.value);
                  setModelName(selected?.model || "");
                }}
              >
                {providers.map((provider) => (
                  <option key={provider.name}>{provider.name}</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Task</span>
              <select
                className="w-full rounded-md border border-line px-3 py-2"
                value={taskType}
                onChange={(event) => setTaskType(event.target.value as TaskType)}
              >
                {taskTypes.map((task) => (
                  <option key={task} value={task}>
                    {task}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Model</span>
              <input
                className="w-full rounded-md border border-line px-3 py-2"
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
              />
            </label>

            {isOllama ? (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">Base URL</span>
                <input
                  className="w-full rounded-md border border-line px-3 py-2"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">API Key</span>
                <input
                  className="w-full rounded-md border border-line px-3 py-2"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Stored encrypted in Postgres"
                />
              </label>
            )}

            <button
              className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={isSaving}
              onClick={saveModel}
            >
              {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : <PlugZap size={16} />}
              Save active model
            </button>
          </div>
        </section>

        <div className="space-y-5">
          <section className="rounded-md border border-line bg-white p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Save size={17} />
              Feature Model Selection
            </div>
            <div className="space-y-4">
              {featureOptions.map((feature) => {
                const setting = featureSettings.find((item) => item.featureKey === feature.key);

                return (
                  <div key={feature.key}>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                      <label className="block text-sm">
                        <span className="mb-1 block font-medium text-slate-700">{feature.label}</span>
                        <select
                          className="w-full rounded-md border border-line px-3 py-2"
                          value={featureModelIds[feature.key]}
                          onChange={(event) =>
                            setFeatureModelIds((current) => ({ ...current, [feature.key]: event.target.value }))
                          }
                        >
                          <option value="">Select a tested model</option>
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.providerName} - {model.modelName} ({model.taskType})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="flex items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                        disabled={savingFeatureKey === feature.key || !featureModelIds[feature.key]}
                        onClick={() => saveFeatureModel(feature.key)}
                      >
                        {savingFeatureKey === feature.key ? (
                          <LoaderCircle className="animate-spin" size={16} />
                        ) : (
                          <Save size={16} />
                        )}
                        Save
                      </button>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      {setting
                        ? `Current: ${setting.providerName} ${setting.modelName}`
                        : `No ${feature.label} model selected yet.`}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-md border border-line bg-white">
            <div className="border-b border-line px-5 py-4 text-sm font-semibold">Configured Models</div>
          {models.length === 0 ? (
            <div className="px-5 py-8 text-sm text-slate-500">No model configurations saved yet.</div>
          ) : (
            <div className="divide-y divide-line">
              {models.map((model) => (
                <div key={model.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{model.providerName}</span>
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{model.taskType}</span>
                      {model.isActive ? (
                        <span className="flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                          <CheckCircle2 size={13} />
                          active
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">{model.modelName}</div>
                  </div>
                  <div className="flex gap-2">
                    {!model.isActive ? (
                      <button
                        className="rounded-md border border-line px-3 py-2 text-sm hover:bg-slate-50"
                        onClick={() => activateModel(model.id)}
                      >
                        Activate
                      </button>
                    ) : null}
                    <button
                      className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
                      disabled={testingModelId === model.id}
                      onClick={() => testModel(model.id)}
                    >
                      {testingModelId === model.id ? <LoaderCircle className="animate-spin" size={14} /> : null}
                      Test connection
                    </button>
                    <button
                      className="flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
                      disabled={deletingModelId === model.id}
                      onClick={() => deleteModel(model)}
                    >
                      {deletingModelId === model.id ? (
                        <LoaderCircle className="animate-spin" size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          </section>
        </div>
      </div>

      {message ? <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function findFeatureModelId(settings: FeatureSetting[], featureKey: FeatureKey) {
  return settings.find((setting) => setting.featureKey === featureKey)?.modelConfigId || "";
}

function featureLabel(featureKey: FeatureKey) {
  return featureOptions.find((feature) => feature.key === featureKey)?.label || featureKey;
}
