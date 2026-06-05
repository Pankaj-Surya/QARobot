"use client";

import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost } from "@/lib/api-client";
import { AlertTriangle, CheckCircle2, Code2, FileCode2, Globe2, LoaderCircle, RefreshCw, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type TestCase = { id: string; tcId: string; title: string; module: string; createdAt?: string };
type InputMode = "saved" | "manual";
type GenerationMode = "stable_auto" | "llm_dom" | "llm_only" | "deterministic_dom" | "deterministic_only";
type Script = {
  id: string;
  name: string;
  framework: string;
  testCaseIds: string[];
  files: Record<string, string>;
  appUrl: string | null;
  inputMode: InputMode;
  generationMode?: GenerationMode;
  generationMeta?: {
    label: string;
    modelRequired: boolean;
    modelUsed: boolean;
    domInspectionRequired: boolean;
    domInspectionMode: string;
    deterministicUsed: boolean;
    validationStatus?: string;
    validationAttempts?: number;
  };
  manualTestCaseText: string | null;
  pageContext?: { mode?: string; title?: string; warnings?: string[] } | null;
  generationWarnings: string[];
  createdAt: string;
  storage?: "local" | "database";
};

type ConfigCheck = {
  ok: boolean;
  generationMode: GenerationMode;
  label: string;
  model: {
    required: boolean;
    ok: boolean;
    providerName?: string;
    modelName?: string;
    taskType?: string;
    message: string;
  };
  domInspection: {
    required: boolean;
    ok: boolean;
    mode?: string;
    title?: string;
    finalUrl?: string;
    warnings?: string[];
    message: string;
  };
};

const LOCAL_SCRIPTS_KEY = "qarobot.generatedScripts";
const TEST_CASES_CHANGED_KEY = "qarobot.testCasesChanged";
const RECENT_CASE_LIMIT = 20;
const GENERATION_MODES: Array<{ value: GenerationMode; label: string; description: string }> = [
  {
    value: "stable_auto",
    label: "Stable Auto Generate",
    description: "Recommended. Tries DOM + LLM, degrades gracefully if blocked, then validates with the runner worker when available.",
  },
  {
    value: "llm_dom",
    label: "LLM + DOM inspection",
    description: "Requires a tested scripting model and a reachable runner worker for browser DOM inspection.",
  },
  {
    value: "llm_only",
    label: "LLM only",
    description: "Requires a tested scripting model. Uses your testcase text without browser DOM inspection.",
  },
  {
    value: "deterministic_dom",
    label: "Deterministic fallback + DOM inspection",
    description: "Requires the runner worker. Uses rules plus inspected DOM, no LLM.",
  },
  {
    value: "deterministic_only",
    label: "Deterministic fallback only",
    description: "No model or runner required. Best only for simple smoke scripts.",
  },
];

export default function ScriptsPage() {
  const [cases, setCases] = useState<TestCase[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [name, setName] = useState("Generated Playwright Suite");
  const [appUrl, setAppUrl] = useState("http://localhost:3000");
  const [inputMode, setInputMode] = useState<InputMode>("saved");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("stable_auto");
  const [manualTestCaseText, setManualTestCaseText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingCases, setIsLoadingCases] = useState(false);
  const [isCheckingConfig, setIsCheckingConfig] = useState(false);
  const [configCheck, setConfigCheck] = useState<ConfigCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const files = selectedScript?.files || {};
  const currentFileContent = selectedFile ? files[selectedFile] : "";
  const selectedCount = useMemo(() => selectedCaseIds.length, [selectedCaseIds]);
  const canGenerate =
    !isGenerating &&
    name.trim().length > 0 &&
    /^https?:\/\/.+/i.test(appUrl.trim()) &&
    (inputMode === "saved" ? selectedCount > 0 : manualTestCaseText.trim().length > 0);

  async function loadSavedCases() {
    setIsLoadingCases(true);
    try {
      const casesResult = await apiGet<{ testCases: TestCase[] }>(`/api/test-cases?limit=${RECENT_CASE_LIMIT}`);
      const recentCases = sortRecentCases(casesResult.testCases).slice(0, RECENT_CASE_LIMIT);
      setCases(recentCases);
      setSelectedCaseIds((current) => current.filter((id) => recentCases.some((testCase) => testCase.id === id)));
    } finally {
      setIsLoadingCases(false);
    }
  }

  async function loadData() {
    await loadSavedCases();
    const localScripts = readLocalScripts();
    setScripts(localScripts);
    if (!selectedScript && localScripts.length > 0) {
      setSelectedScript(localScripts[0]);
      setSelectedFile(Object.keys(localScripts[0].files)[0]);
    }
  }

  useEffect(() => {
    loadData().catch((loadError) => setError(readError(loadError)));
    const refreshCases = () => loadData().catch((loadError) => setError(readError(loadError)));
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshCases();
    };
    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === TEST_CASES_CHANGED_KEY) refreshCases();
    };
    window.addEventListener("focus", refreshCases);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("storage", refreshFromStorage);
    const clearLocalScripts = clearLocalScriptsOnPageUnload();
    return () => {
      window.removeEventListener("focus", refreshCases);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("storage", refreshFromStorage);
      clearLocalScripts?.();
    };
  }, []);

  async function generateScript() {
    setError(null);
    setIsGenerating(true);

    try {
      const result = await apiPost<{ script: Script }>("/api/scripts/generate", {
        name,
        appUrl,
        inputMode,
        generationMode,
        framework: "playwright",
        testCaseIds: inputMode === "saved" ? selectedCaseIds : [],
        manualTestCaseText: inputMode === "manual" ? manualTestCaseText : "",
      });
      const localScripts = [result.script];
      localStorage.setItem(LOCAL_SCRIPTS_KEY, JSON.stringify(localScripts));
      setSelectedScript(result.script);
      setSelectedFile(Object.keys(result.script.files)[0]);
      setScripts(localScripts);
    } catch (generateError) {
      setError(readError(generateError));
    } finally {
      setIsGenerating(false);
    }
  }

  async function testGenerationConfig() {
    setError(null);
    setConfigCheck(null);
    setIsCheckingConfig(true);

    try {
      const result = await apiPost<ConfigCheck>("/api/scripts/test-generation-config", {
        appUrl,
        generationMode,
      });
      setConfigCheck(result);
    } catch (checkError) {
      setError(readError(checkError));
    } finally {
      setIsCheckingConfig(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Test Script Generator</h1>
        <p className="mt-1 text-sm text-slate-500">
          Generate app-aware Playwright scripts from saved or manually entered testcases.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[390px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Script name</span>
              <input className="w-full rounded-md border border-line px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
            </label>

            <label className="block text-sm">
              <span className="mb-1 flex items-center gap-2 font-medium">
                <Globe2 size={15} />
                App URL
              </span>
              <input
                className="w-full rounded-md border border-line px-3 py-2"
                value={appUrl}
                onChange={(event) => setAppUrl(event.target.value)}
                placeholder="https://your-app.example.com"
              />
            </label>

            <div>
              <div className="mb-2 text-sm font-medium">Generation option</div>
              <div className="space-y-2">
                {GENERATION_MODES.map((mode) => (
                  <label
                    key={mode.value}
                    className={`block cursor-pointer rounded-md border p-3 text-sm ${
                      generationMode === mode.value ? "border-action bg-blue-50" : "border-line bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <input
                        className="mt-1"
                        type="radio"
                        checked={generationMode === mode.value}
                        onChange={() => {
                          setGenerationMode(mode.value);
                          setConfigCheck(null);
                        }}
                      />
                      <span>
                        <span className="block font-medium">{mode.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-slate-500">{mode.description}</span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">Testcase source</div>
              <div className="grid grid-cols-2 overflow-hidden rounded-md border border-line text-sm">
                <button
                  className={`px-3 py-2 ${inputMode === "saved" ? "bg-action text-white" : "bg-white hover:bg-slate-50"}`}
                  onClick={() => {
                    setInputMode("saved");
                    loadSavedCases().catch((loadError) => setError(readError(loadError)));
                  }}
                >
                  Saved cases
                </button>
                <button
                  className={`px-3 py-2 ${inputMode === "manual" ? "bg-action text-white" : "bg-white hover:bg-slate-50"}`}
                  onClick={() => setInputMode("manual")}
                >
                  Manual text
                </button>
              </div>
            </div>

            {inputMode === "saved" ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Recent saved test cases</div>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    disabled={isLoadingCases}
                    onClick={() => loadSavedCases().catch((loadError) => setError(readError(loadError)))}
                    type="button"
                  >
                    {isLoadingCases ? <LoaderCircle className="animate-spin" size={13} /> : <RefreshCw size={13} />}
                    Refresh
                  </button>
                </div>
                <div className="max-h-64 space-y-2 overflow-auto rounded-md border border-line p-2">
                  {isLoadingCases && cases.length === 0 ? (
                    <div className="px-2 py-4 text-sm text-slate-500">Loading saved test cases...</div>
                  ) : cases.length === 0 ? (
                    <div className="px-2 py-4 text-sm text-slate-500">No saved test cases.</div>
                  ) : (
                    cases.map((testCase) => (
                      <label key={testCase.id} className="flex items-start gap-2 rounded px-2 py-2 text-sm hover:bg-slate-50">
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={selectedCaseIds.includes(testCase.id)}
                          onChange={(event) =>
                            setSelectedCaseIds((current) =>
                              event.target.checked ? [...current, testCase.id] : current.filter((id) => id !== testCase.id),
                            )
                          }
                        />
                        <span>
                          <span className="font-medium">{testCase.tcId}</span> {testCase.title}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Manual testcase text</span>
                <textarea
                  className="h-48 w-full rounded-md border border-line p-3"
                  value={manualTestCaseText}
                  onChange={(event) => setManualTestCaseText(event.target.value)}
                  placeholder={"TC: Login succeeds\nPrecondition: User is on login page\n1. Enter valid username\n2. Enter valid password\n3. Click Sign In\nExpected: User lands on dashboard"}
                />
              </label>
            )}

            <div className="rounded-md border border-line bg-slate-50 p-3 text-sm text-slate-600">
              Saved cases come from the backend database. Showing the latest {RECENT_CASE_LIMIT}; use Refresh after saving new cases.
            </div>

            <button
              className="flex w-full items-center justify-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              disabled={isCheckingConfig || !/^https?:\/\/.+/i.test(appUrl.trim())}
              onClick={testGenerationConfig}
            >
              {isCheckingConfig ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
              Test generation configuration
            </button>

            {configCheck ? <ConfigCheckPanel check={configCheck} /> : null}

            <button className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={!canGenerate} onClick={generateScript}>
              {isGenerating ? <LoaderCircle className="animate-spin" size={16} /> : <Wand2 size={16} />}
              Generate script
            </button>
          </div>
        </section>

        <section className="grid min-h-[680px] overflow-hidden rounded-md border border-line bg-white lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-r border-line">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold">Latest Temporary Script</div>
            <div className="max-h-64 overflow-auto border-b border-line">
              {scripts.length === 0 ? (
                <div className="px-4 py-6 text-sm text-slate-500">No temporary script yet.</div>
              ) : scripts.map((script) => (
                <button key={script.id} className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-50" onClick={() => { setSelectedScript(script); setSelectedFile(Object.keys(script.files)[0]); }}>
                  <div className="font-medium">{script.name}</div>
                  <div className="truncate text-xs text-slate-500">{script.appUrl || "No app URL"} - local</div>
                </button>
              ))}
            </div>
            {selectedScript ? (
              <div className="border-b border-line p-4 text-xs text-slate-600">
                <div className="font-semibold text-slate-700">Script context</div>
                <div className="mt-2">Mode: {selectedScript.inputMode}</div>
                <div className="mt-1">Generation: {selectedScript.generationMeta?.label || formatGenerationMode(selectedScript.generationMode)}</div>
                <div className="mt-1 truncate">App: {selectedScript.appUrl || "-"}</div>
                <div className="mt-1">Page: {selectedScript.pageContext?.title || "Unknown"}</div>
                {selectedScript.generationMeta?.validationStatus ? (
                  <div className="mt-1">
                    Validation: {selectedScript.generationMeta.validationStatus}
                    {selectedScript.generationMeta.validationAttempts ? ` (${selectedScript.generationMeta.validationAttempts} attempt)` : ""}
                  </div>
                ) : null}
                {selectedScript.generationMeta ? (
                  <div className="mt-1">
                    Model: {selectedScript.generationMeta.modelUsed ? "used" : selectedScript.generationMeta.modelRequired ? "required" : "not required"} · DOM:{" "}
                    {selectedScript.generationMeta.domInspectionMode}
                  </div>
                ) : null}
                {selectedScript.generationWarnings?.length ? (
                  <div className="mt-2 rounded bg-amber-50 p-2 text-amber-700">{selectedScript.generationWarnings.join(" ")}</div>
                ) : null}
              </div>
            ) : null}
            <div className="px-4 py-3 text-sm font-semibold">Files</div>
            {Object.keys(files).map((file) => (
              <button key={file} className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50 ${selectedFile === file ? "bg-slate-100" : ""}`} onClick={() => setSelectedFile(file)}>
                <FileCode2 size={15} />
                <span className="truncate">{file}</span>
              </button>
            ))}
          </aside>
          <main className="min-w-0">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
              <Code2 size={16} />
              {selectedFile || "No file selected"}
            </div>
            <pre className="h-[632px] overflow-auto bg-slate-950 p-4 text-sm text-slate-100">
              <code>{currentFileContent || "Generate or select a script to view files."}</code>
            </pre>
          </main>
        </section>
      </div>

      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function ConfigCheckPanel({ check }: { check: ConfigCheck }) {
  return (
    <div className={`rounded-md border p-3 text-sm ${check.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className={`flex items-center gap-2 font-semibold ${check.ok ? "text-emerald-700" : "text-amber-800"}`}>
        {check.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        {check.label}: {check.ok ? "ready" : "needs attention"}
      </div>
      <div className="mt-3 space-y-2 text-slate-700">
        <CheckRow label="Model" required={check.model.required} ok={check.model.ok} message={modelMessage(check)} />
        <CheckRow label="DOM inspection" required={check.domInspection.required} ok={check.domInspection.ok} message={check.domInspection.message} />
      </div>
    </div>
  );
}

function CheckRow({ label, required, ok, message }: { label: string; required: boolean; ok: boolean; message: string }) {
  return (
    <div className="rounded bg-white/70 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
          {required ? (ok ? "required ok" : "required failed") : "not required"}
        </span>
      </div>
      <div className="mt-1 text-xs leading-5 text-slate-600">{message}</div>
    </div>
  );
}

function modelMessage(check: ConfigCheck) {
  if (!check.model.required) return check.model.message;
  if (check.model.ok) {
    return `${check.model.providerName || "Model"} ${check.model.modelName || ""} is connected for Test Script Generator.`.trim();
  }
  return check.model.message;
}

function readLocalScripts(): Script[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_SCRIPTS_KEY) || "[]") as Script[];
    return Array.isArray(parsed) ? parsed.slice(0, 1).map(cleanScriptWarnings) : [];
  } catch {
    return [];
  }
}

function sortRecentCases(testCases: TestCase[]) {
  return [...testCases].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return numericTcId(right.tcId) - numericTcId(left.tcId);
  });
}

function numericTcId(value: string) {
  return Number(value.match(/\d+/)?.[0] || 0);
}

function clearLocalScriptsOnPageUnload() {
  if (typeof window === "undefined") return;
  const cleanup = () => localStorage.removeItem(LOCAL_SCRIPTS_KEY);
  window.addEventListener("beforeunload", cleanup);
  return () => window.removeEventListener("beforeunload", cleanup);
}

function cleanScriptWarnings(script: Script): Script {
  return {
    ...script,
    generationWarnings: (script.generationWarnings || []).filter((warning) => !isHiddenGeneratorWarning(warning)),
  };
}

function isHiddenGeneratorWarning(warning: string) {
  return /No scripting model selected/i.test(warning) || /recoverable non-standard JSON/i.test(warning);
}

function formatGenerationMode(mode?: GenerationMode) {
  return GENERATION_MODES.find((item) => item.value === mode)?.label || "Unknown";
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
