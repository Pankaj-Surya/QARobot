"use client";

import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost, apiPut } from "@/lib/api-client";
import { BarChart3, CheckCircle2, FileArchive, FileText, HelpCircle, ImageIcon, LoaderCircle, Monitor, Play, PlugZap, Terminal, Video, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

type Script = { id: string; name: string; framework: string; appUrl: string | null; testCaseIds: string[]; files: Record<string, string>; createdAt?: string; storage?: "local" | "database" };
type RunReport = {
  mode: "playwright";
  status: string;
  scriptName: string;
  appUrl: string | null;
  browser: string;
  headed?: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tests: Array<{ title: string; status: string; durationMs: number; error?: string }>;
  stdout?: string;
  stderr?: string;
  runDir?: string;
};
type Run = {
  id: string;
  scriptId: string;
  status: string;
  browser: string;
  startedAt: string | null;
  completedAt: string | null;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  results?: RunReport | null;
};
type RunLog = { type: "info" | "pass" | "fail" | "warn" | "done"; message: string; at: string };
type ArtifactItem = { type: "html-report" | "screenshot" | "trace" | "video" | "file"; name: string; path: string; url: string; size: number };
type ArtifactManifest = { runId: string; artifacts: ArtifactItem[] };
type RunnerConfig = {
  mode: string;
  workerConfigured: boolean;
  message: string;
  workerUrlSet?: boolean;
  workerUrl?: string;
  callbackBaseUrl?: string;
  requiredBackendEnv?: Record<string, string>;
  supportedOptions?: Array<{ key: string; label: string; description: string }>;
};

const LOCAL_SCRIPTS_KEY = "qarobot.generatedScripts";

export default function RunnerPage() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [scriptSource, setScriptSource] = useState<"saved" | "inline">("saved");
  const [inlineName, setInlineName] = useState("Pasted Playwright script");
  const [inlineAppUrl, setInlineAppUrl] = useState("");
  const [inlineScriptText, setInlineScriptText] = useState("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [browser, setBrowser] = useState("chromium");
  const [headed, setHeaded] = useState(false);
  const [outputTab, setOutputTab] = useState<"logs" | "browser" | "report" | "screenshots" | "trace" | "video">("logs");
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig | null>(null);
  const [workerUrl, setWorkerUrl] = useState("http://localhost:4001");
  const [callbackBaseUrl, setCallbackBaseUrl] = useState("http://localhost:3001");
  const [isStarting, setIsStarting] = useState(false);
  const [isTestingWorker, setIsTestingWorker] = useState(false);
  const [isSavingWorker, setIsSavingWorker] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedScript = useMemo(
    () => scripts.find((script) => script.id === selectedScriptId) || null,
    [scripts, selectedScriptId],
  );
  const discoveredTests = scriptSource === "inline" ? countTests({ "tests/pasted.spec.ts": inlineScriptText }) : selectedScript ? countTests(selectedScript.files) : 0;
  const runAppUrl = scriptSource === "inline" ? inlineAppUrl : selectedScript?.appUrl || "";
  const pastedScriptWarning = scriptSource === "inline" ? detectPastedScriptWarning(inlineScriptText) : "";

  async function loadData() {
    const [scriptsResult, runsResult] = await Promise.all([
      apiGet<{ scripts: Script[] }>("/api/scripts"),
      apiGet<{ runs: Run[] }>("/api/runs"),
    ]);
    apiGet<RunnerConfig>("/api/runs/config").then((config) => {
      setRunnerConfig(config);
      if (config.workerUrl) setWorkerUrl(config.workerUrl);
      if (config.callbackBaseUrl) setCallbackBaseUrl(config.callbackBaseUrl);
    }).catch(() => {
      setRunnerConfig({ mode: "disabled", workerConfigured: false, message: "Runner configuration could not be loaded." });
    });
    const localScripts = readLocalScripts();
    const dbScripts = scriptsResult.scripts.map((script) => ({ ...script, storage: "database" as const }));
    const allScripts = [...localScripts, ...dbScripts];
    setScripts(allScripts);
    setRuns(runsResult.runs);
    if (!selectedScriptId && allScripts.length > 0) {
      setSelectedScriptId(allScripts[0].id);
    }
    if (!selectedRun && runsResult.runs.length > 0) {
      setSelectedRun(runsResult.runs[0]);
    }
  }

  async function testWorkerConnection() {
    setConnectionMessage(null);
    setError(null);
    setIsTestingWorker(true);
    try {
      await apiPost("/api/runs/test-connection", { workerUrl });
      setConnectionMessage("Worker connection is healthy.");
    } catch (testError) {
      setConnectionMessage(null);
      setError(readError(testError));
    } finally {
      setIsTestingWorker(false);
    }
  }

  async function saveWorkerConnection() {
    setConnectionMessage(null);
    setError(null);
    setIsSavingWorker(true);
    try {
      const result = await apiPut<{ config: RunnerConfig }>("/api/runs/settings", {
        mode: "worker",
        workerUrl,
        callbackBaseUrl,
      });
      setRunnerConfig((current) => ({ ...(current || result.config), ...result.config, message: "Runner worker is configured." }));
      setConnectionMessage("Runner connection saved. No backend env edit is needed.");
    } catch (saveError) {
      setError(readError(saveError));
    } finally {
      setIsSavingWorker(false);
    }
  }

  useEffect(() => {
    loadData().catch((loadError) => setError(readError(loadError)));
    return clearLocalScriptsOnPageUnload();
  }, []);

  async function startRun() {
    setError(null);
    setLogs([]);
    setIsStarting(true);

    try {
      const generatedScriptText = selectedScript ? getRunnableSpec(selectedScript.files) : "";
      const payload = scriptSource === "inline"
        ? { source: "inline", name: inlineName, appUrl: inlineAppUrl, scriptText: inlineScriptText, browser, headed }
        : selectedScript?.storage === "local"
          ? { source: "inline", name: selectedScript.name, appUrl: selectedScript.appUrl, scriptText: generatedScriptText, browser, headed }
        : { source: "saved", scriptId: selectedScriptId, browser, headed };
      const result = await apiPost<{ run: Run }>("/api/runs/start", payload);
      setSelectedRun(result.run);
      setOutputTab(headed ? "browser" : "logs");
      streamRun(result.run.id);
      await loadData();
    } catch (startError) {
      setError(readError(startError));
    } finally {
      setIsStarting(false);
    }
  }

  async function loadRun(runId: string) {
    const result = await apiGet<{ run: Run; logs: RunLog[] }>(`/api/runs/${runId}`);
    setSelectedRun(result.run);
    setLogs(result.logs);
  }

  function streamRun(runId: string) {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    const source = new EventSource(`${apiUrl}/api/runs/${runId}/stream`);
    source.onmessage = (event) => {
      const entry = JSON.parse(event.data) as RunLog;
      setLogs((current) => [...current, entry]);
      if (entry.type === "done" || entry.type === "fail") {
        source.close();
        loadData().catch((loadError) => setError(readError(loadError)));
        loadRun(runId).catch((loadError) => setError(readError(loadError)));
        loadArtifacts(runId).catch(() => undefined);
      }
    };
    source.onerror = () => {
      source.close();
    };
  }

  async function loadArtifacts(runId: string) {
    const result = await apiGet<ArtifactManifest>(`/api/runs/${runId}/artifacts`);
    setArtifacts(result.artifacts || []);
  }

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Test Runner</h1>
        <p className="mt-1 text-sm text-slate-500">Queue generated Playwright scripts to a separate local or cloud runner and review execution reports.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="space-y-4">
            <div className="text-sm">
              <span className="mb-2 block font-medium">Script source</span>
              <div className="grid grid-cols-2 rounded-md border border-line p-1">
                <button className={`rounded px-3 py-2 text-sm ${scriptSource === "saved" ? "bg-action text-white" : "text-slate-700 hover:bg-slate-50"}`} type="button" onClick={() => setScriptSource("saved")}>Saved script</button>
                <button className={`rounded px-3 py-2 text-sm ${scriptSource === "inline" ? "bg-action text-white" : "text-slate-700 hover:bg-slate-50"}`} type="button" onClick={() => setScriptSource("inline")}>Paste script</button>
              </div>
            </div>

            {scriptSource === "saved" ? (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Script</span>
                <select className="w-full rounded-md border border-line px-3 py-2" value={selectedScriptId} onChange={(event) => setSelectedScriptId(event.target.value)}>
                  {scripts.map((script) => <option key={script.id} value={script.id}>{scriptLabel(script)}</option>)}
                </select>
              </label>
            ) : (
              <div className="space-y-3 rounded-md border border-line p-3 text-sm">
                <label className="block">
                  <span className="mb-1 block font-medium">Run name</span>
                  <input className="w-full rounded-md border border-line px-3 py-2" value={inlineName} onChange={(event) => setInlineName(event.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">App URL</span>
                  <input className="w-full rounded-md border border-line px-3 py-2" placeholder="https://example.com" value={inlineAppUrl} onChange={(event) => setInlineAppUrl(event.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">Playwright script</span>
                  <textarea
                    className="h-48 w-full resize-y rounded-md border border-line px-3 py-2 font-mono text-xs"
                    placeholder={"import { expect, test } from \"@playwright/test\";\n\ntest(\"example\", async ({ page }) => {\n  await page.goto(\"/\");\n  await expect(page).toHaveURL(/.*/);\n});"}
                    value={inlineScriptText}
                    onChange={(event) => setInlineScriptText(event.target.value)}
                  />
                  {pastedScriptWarning ? <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-700">{pastedScriptWarning}</div> : null}
                </label>
              </div>
            )}

            <label className="block text-sm">
              <span className="mb-1 block font-medium">Browser</span>
              <select className="w-full rounded-md border border-line px-3 py-2" value={browser} onChange={(event) => setBrowser(event.target.value)}>
                <option value="chromium">Chromium</option>
                <option value="firefox">Firefox</option>
                <option value="webkit">WebKit</option>
              </select>
            </label>

            <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm">
              <input className="mt-1" type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} />
              <span>
                <span className="block font-medium">Run headed</span>
                <span className="mt-1 block text-slate-500">Open a visible browser on the runner machine while the test is running.</span>
              </span>
            </label>

            <div className="rounded-md border border-line bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Run setup</div>
              <div className="mt-2 text-slate-600">Script: {scriptSource === "inline" ? inlineName || "-" : selectedScript?.name || "-"}</div>
              <div className="mt-1 break-all text-slate-600">App URL: {runAppUrl || "Missing app URL"}</div>
              <div className="mt-1 text-slate-600">Tests discovered: {discoveredTests}</div>
              <div className="mt-1 text-slate-600">Browser mode: {headed ? "Headed visible browser" : "Headless"}</div>
              <div className="mt-1 text-slate-600">Configured mode: {runnerConfig?.mode || "checking"}</div>
              <div className={`mt-2 rounded p-2 ${runnerConfig?.workerConfigured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {runnerConfig?.message || "Checking runner worker configuration..."}
              </div>
            </div>

            <div className="rounded-md border border-line p-3 text-sm">
              <div className="flex items-center gap-2 font-semibold">
                <PlugZap size={16} />
                Connect Runner
              </div>
              <label className="mt-3 block">
                <span className="mb-1 block font-medium">Worker URL</span>
                <input className="w-full rounded-md border border-line px-3 py-2" value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="http://localhost:4001" />
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block font-medium">Backend callback URL</span>
                <input className="w-full rounded-md border border-line px-3 py-2" value={callbackBaseUrl} onChange={(event) => setCallbackBaseUrl(event.target.value)} placeholder="http://localhost:3001" />
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button className="inline-flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60" type="button" disabled={isTestingWorker || !workerUrl.trim()} onClick={testWorkerConnection}>
                  {isTestingWorker ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                  Test connection
                </button>
                <button className="inline-flex items-center justify-center gap-2 rounded-md bg-action px-3 py-2 font-medium text-white disabled:opacity-60" type="button" disabled={isSavingWorker || !workerUrl.trim()} onClick={saveWorkerConnection}>
                  {isSavingWorker ? <LoaderCircle className="animate-spin" size={16} /> : <PlugZap size={16} />}
                  Save connection
                </button>
              </div>
              {connectionMessage ? <div className="mt-3 rounded bg-emerald-50 p-2 text-xs text-emerald-700">{connectionMessage}</div> : null}
            </div>

            <div className="rounded-md border border-line p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold">Execution options</div>
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => setShowSetup(true)}
                  type="button"
                >
                  <HelpCircle size={14} />
                  Setup instructions
                </button>
              </div>
              <div className="mt-3 space-y-3">
                <RunnerOption
                  title="Local Machine Runner"
                  description="Best for development. Start the separate runner on this machine, then save http://localhost:4001 in Connect Runner."
                  command="cd qarobot-runner-worker && npm install && npm run install:browsers && npm run dev"
                />
                <RunnerOption
                  title="Cloud/VM Worker"
                  description="Best for Vercel production. Deploy the same runner worker to a VM/Railway/Render/Fly service and save that public URL in Connect Runner."
                  command="Worker URL = https://your-runner-worker"
                />
              </div>
            </div>

            <button className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={isStarting || !canStartRun(scriptSource, selectedScriptId, runAppUrl, inlineName, inlineScriptText, runnerConfig?.workerConfigured)} onClick={startRun}>
              {isStarting ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}
              Queue runner job
            </button>
          </div>
        </section>

        <section className="rounded-md border border-line bg-white">
          <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
            <OutputTabButton active={outputTab === "logs"} icon={<Terminal size={15} />} label="Live Logs" onClick={() => setOutputTab("logs")} />
            <OutputTabButton active={outputTab === "browser"} icon={<Monitor size={15} />} label="Browser Run" onClick={() => setOutputTab("browser")} />
            <OutputTabButton active={outputTab === "report"} icon={<FileText size={15} />} label="HTML Report" onClick={() => setOutputTab("report")} />
            <OutputTabButton active={outputTab === "screenshots"} icon={<ImageIcon size={15} />} label="Screenshots" onClick={() => setOutputTab("screenshots")} />
            <OutputTabButton active={outputTab === "trace"} icon={<FileArchive size={15} />} label="Trace" onClick={() => setOutputTab("trace")} />
            <OutputTabButton active={outputTab === "video"} icon={<Video size={15} />} label="Video" onClick={() => setOutputTab("video")} />
          </div>
          {outputTab === "logs" ? (
            <div className="h-80 overflow-auto bg-slate-950 p-4 font-mono text-sm text-slate-100">
              {logs.length === 0 ? <div className="text-slate-400">Run logs appear here.</div> : logs.map((entry, index) => (
                <div key={index} className={entry.type === "pass" ? "text-emerald-300" : entry.type === "fail" ? "text-red-300" : entry.type === "warn" ? "text-amber-300" : "text-slate-200"}>
                  [{entry.type}] {entry.message}
                </div>
              ))}
            </div>
          ) : outputTab === "browser" ? (
            <BrowserRunPanel
              appUrl={runAppUrl || selectedRun?.results?.appUrl || null}
              browser={browser}
              headed={headed || Boolean(selectedRun?.results?.headed)}
              status={selectedRun?.status || "not started"}
              workerUrl={runnerConfig?.workerUrl || workerUrl}
            />
          ) : (
            <ArtifactPanel type={outputTab} artifacts={artifacts} runId={selectedRun?.id || null} onRefresh={() => selectedRun ? loadArtifacts(selectedRun.id).catch((loadError) => setError(readError(loadError))) : undefined} />
          )}
        </section>
      </div>

      <section className="mt-5 rounded-md border border-line bg-white">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          <BarChart3 size={16} />
          Run Report
        </div>
        {!selectedRun?.results ? (
          <div className="px-5 py-8 text-sm text-slate-500">Select or complete a run to see report details.</div>
        ) : (
          <RunReportView report={selectedRun.results} />
        )}
      </section>

      <section className="mt-5 rounded-md border border-line bg-white">
        <div className="border-b border-line px-5 py-4 text-sm font-semibold">Run History</div>
        {runs.length === 0 ? <div className="px-5 py-8 text-sm text-slate-500">No runs yet.</div> : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-slate-50">
                <tr>
                  {["Status", "Browser", "Total", "Passed", "Failed", "Started", "Completed"].map((heading) => (
                    <th key={heading} className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-500">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {runs.map((run) => (
                  <tr key={run.id} className="cursor-pointer hover:bg-slate-50" onClick={() => { loadRun(run.id).catch((loadError) => setError(readError(loadError))); loadArtifacts(run.id).catch(() => setArtifacts([])); }}>
                    <td className="px-3 py-2 text-sm">{run.status}</td>
                    <td className="px-3 py-2 text-sm">{run.browser}</td>
                    <td className="px-3 py-2 text-sm">{run.totalTests}</td>
                    <td className="px-3 py-2 text-sm">{run.passedCount}</td>
                    <td className="px-3 py-2 text-sm">{run.failedCount}</td>
                    <td className="px-3 py-2 text-sm">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}</td>
                    <td className="px-3 py-2 text-sm">{run.completedAt ? new Date(run.completedAt).toLocaleString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {showSetup ? <RunnerSetupModal onClose={() => setShowSetup(false)} /> : null}
    </AppShell>
  );
}

function RunnerSetupModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Runner Setup Instructions</h2>
            <p className="mt-1 text-sm text-slate-500">Use a separate runner for browser execution. The main Vercel/API app should only queue jobs.</p>
          </div>
          <button className="rounded-md p-2 text-slate-500 hover:bg-slate-100" onClick={onClose} type="button" aria-label="Close setup instructions">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(90vh-82px)] overflow-auto px-5 py-4 text-sm text-slate-700">
          <SetupBlock
            title="Local Windows"
            steps={[
              "Install Node.js 20 or newer.",
              "Open PowerShell in the project root.",
              "Run: cd qarobot-runner-worker",
              "Run: npm install",
              "Run: npm run install:browsers",
              "Run: copy .env.example .env",
              "Run: npm run dev",
              "In the Runner page, set Worker URL to http://localhost:4001 and Backend callback URL to http://localhost:3001.",
              "Click Test connection, then Save connection.",
            ]}
          />
          <SetupBlock
            title="Local macOS / Linux"
            steps={[
              "Install Node.js 20 or newer.",
              "Open a terminal in the project root.",
              "Run: cd qarobot-runner-worker",
              "Run: npm install",
              "Run: npm run install:browsers",
              "Run: cp .env.example .env",
              "Run: npm run dev",
              "In the Runner page, set Worker URL to http://localhost:4001 and Backend callback URL to http://localhost:3001.",
              "Click Test connection, then Save connection.",
            ]}
          />
          <SetupBlock
            title="AWS VM"
            steps={[
              "Create an EC2 Ubuntu instance with Node.js 20+ installed.",
              "Open inbound TCP port 4001 in the security group, or put the worker behind Nginx/HTTPS.",
              "Copy or deploy the qarobot-runner-worker folder to the VM.",
              "Run: npm install",
              "Run: npm run install:browsers",
              "Set worker env QA_ROBOT_CALLBACK_BASE_URL=https://your-backend-api.example.com.",
              "Start the worker with npm run start after npm run build, or use pm2/systemd.",
              "In the Runner page, save Worker URL as https://your-aws-worker-domain-or-ip and Backend callback URL as https://your-backend-api.example.com.",
            ]}
          />
          <SetupBlock
            title="Azure VM"
            steps={[
              "Create an Azure Ubuntu VM with Node.js 20+ installed.",
              "Allow inbound TCP port 4001 in Network Security Group rules, or expose the worker through Nginx/HTTPS.",
              "Copy or deploy the qarobot-runner-worker folder to the VM.",
              "Run: npm install",
              "Run: npm run install:browsers",
              "Set worker env QA_ROBOT_CALLBACK_BASE_URL=https://your-backend-api.example.com.",
              "Start the worker with npm run start after npm run build, or use pm2/systemd.",
              "In the Runner page, save Worker URL as https://your-azure-worker-domain-or-ip and Backend callback URL as https://your-backend-api.example.com.",
            ]}
          />
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
            Browser binaries are installed only in <code>qarobot-runner-worker</code>. QA Robot stores the worker connection from this page; backend env values are only fallback for advanced deployments.
          </div>
        </div>
      </div>
    </div>
  );
}

function SetupBlock({ title, steps }: { title: string; steps: string[] }) {
  return (
    <section className="mb-4 rounded-md border border-line p-4">
      <h3 className="font-semibold">{title}</h3>
      <ol className="mt-3 list-decimal space-y-2 pl-5">
        {steps.map((step) => (
          <li key={step}>{formatStep(step)}</li>
        ))}
      </ol>
    </section>
  );
}

function OutputTabButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-action text-white" : "text-slate-600 hover:bg-slate-50"}`}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function BrowserRunPanel({
  appUrl,
  browser,
  headed,
  status,
  workerUrl,
}: {
  appUrl: string | null;
  browser: string;
  headed: boolean;
  status: string;
  workerUrl: string;
}) {
  return (
    <div className="h-80 overflow-auto bg-slate-50 p-5 text-sm">
      <div className="rounded-md border border-line bg-white p-4">
        <div className="flex items-center gap-2 font-semibold">
          <Monitor size={16} />
          Browser Run
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Metric label="Mode" value={headed ? "Headed" : "Headless"} />
          <Metric label="Browser" value={browser} />
          <Metric label="Status" value={status} />
          <Metric label="Worker" value={shortUrl(workerUrl || "-")} />
        </div>
        <div className="mt-4 rounded-md border border-line bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">App URL</div>
          <div className="mt-1 break-all text-slate-700">{appUrl || "-"}</div>
        </div>
        {headed ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
            Headed mode is enabled. The visible browser opens on the machine where <code>qarobot-runner-worker</code> is running. For your local runner, watch the browser window on this computer.
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
            Headed mode is off. Enable <strong>Run headed</strong> before queuing a job if you want to watch the browser on the runner machine.
          </div>
        )}
        <div className="mt-4 text-xs text-slate-500">
          In-browser live video requires a VNC/noVNC stream from the worker. This tab tracks the run and headed mode now; the actual headed browser is shown by the runner machine.
        </div>
      </div>
    </div>
  );
}

function ArtifactPanel({
  type,
  artifacts,
  runId,
  onRefresh,
}: {
  type: "report" | "screenshots" | "trace" | "video";
  artifacts: ArtifactItem[];
  runId: string | null;
  onRefresh: () => void;
}) {
  const artifactType = type === "report" ? "html-report" : type === "screenshots" ? "screenshot" : type;
  const items = artifacts.filter((artifact) => artifact.type === artifactType);
  const title = type === "report" ? "HTML Report" : type === "screenshots" ? "Screenshots" : type === "trace" ? "Trace Files" : "Videos";

  return (
    <div className="h-80 overflow-auto bg-slate-50 p-5 text-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="font-semibold">{title}</div>
        <button className="rounded-md border border-line px-3 py-1 text-xs font-medium hover:bg-white disabled:opacity-60" disabled={!runId} onClick={onRefresh} type="button">
          Refresh
        </button>
      </div>
      {!runId ? (
        <div className="rounded-md border border-line bg-white p-4 text-slate-500">Select or start a run to view artifacts.</div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-line bg-white p-4 text-slate-500">
          No {title.toLowerCase()} available yet. Artifacts are created by the runner worker and kept in temporary worker storage.
        </div>
      ) : type === "screenshots" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((artifact) => (
            <a key={artifact.path} className="rounded-md border border-line bg-white p-3 hover:bg-slate-50" href={artifact.url} rel="noreferrer" target="_blank">
              <img alt={artifact.name} className="max-h-40 w-full rounded object-contain" src={artifact.url} />
              <div className="mt-2 truncate text-xs text-slate-600">{artifact.name}</div>
            </a>
          ))}
        </div>
      ) : type === "video" ? (
        <div className="space-y-4">
          {items.map((artifact) => (
            <div key={artifact.path} className="rounded-md border border-line bg-white p-3">
              <video className="max-h-56 w-full rounded bg-black" controls src={artifact.url} />
              <div className="mt-2 truncate text-xs text-slate-600">{artifact.name}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((artifact) => (
            <a key={artifact.path} className="flex items-center justify-between gap-3 rounded-md border border-line bg-white px-3 py-2 hover:bg-slate-50" href={artifact.url} rel="noreferrer" target="_blank">
              <span className="truncate">{artifact.name}</span>
              <span className="shrink-0 text-xs text-slate-500">{formatBytes(artifact.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function formatStep(step: string) {
  const commandMatch = step.match(/^Run: (.+)$/);
  if (commandMatch) {
    return (
      <>
        Run: <code className="rounded bg-slate-100 px-1 py-0.5">{commandMatch[1]}</code>
      </>
    );
  }
  return step;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function RunReportView({ report }: { report: RunReport }) {
  const tests = Array.isArray(report.tests) ? report.tests : [];
  const durationMs = Number.isFinite(Number(report.durationMs)) ? Number(report.durationMs) : 0;

  return (
    <div className="p-5">
      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="Status" value={report.status || "queued"} />
        <Metric label="Total" value={String(report.total ?? tests.length)} />
        <Metric label="Passed" value={String(report.passed ?? 0)} />
        <Metric label="Failed" value={String(report.failed ?? 0)} />
        <Metric label="Duration" value={`${Math.round(durationMs / 1000)}s`} />
      </div>
      <div className="mt-4 rounded-md border border-line bg-slate-50 p-3 text-sm">
        <div className="font-semibold">{report.scriptName}</div>
        <div className="mt-1 break-all text-slate-600">{report.appUrl || "-"}</div>
        <div className="mt-1 text-slate-600">Browser: {report.browser}</div>
      </div>
      <div className="mt-4 overflow-x-auto rounded-md border border-line">
        <table className="min-w-full divide-y divide-line">
          <thead className="bg-slate-50">
            <tr>
              {["Test", "Status", "Duration", "Error"].map((heading) => (
                <th key={heading} className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-500">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {tests.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-sm text-slate-500" colSpan={4}>
                  No per-test results yet. The worker has not completed this run or this is an older report.
                </td>
              </tr>
            ) : tests.map((test, index) => (
              <tr key={`${test.title}-${index}`}>
                <td className="px-3 py-2 text-sm">{test.title}</td>
                <td className="px-3 py-2 text-sm">{test.status}</td>
                <td className="px-3 py-2 text-sm">{test.durationMs}ms</td>
                <td className="max-w-[480px] whitespace-pre-wrap px-3 py-2 text-sm text-red-700">{test.error || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.stderr ? (
        <details className="mt-4 rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">stderr summary</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-red-700">{report.stderr}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

function RunnerOption({ title, description, command }: { title: string; description: string; command: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="font-medium">{title}</div>
      <p className="mt-1 text-slate-600">{description}</p>
      <code className="mt-2 block overflow-x-auto rounded bg-slate-900 px-2 py-1 text-xs text-slate-100">{command}</code>
    </div>
  );
}

function countTests(files: Record<string, string>) {
  const specs = Object.entries(files)
    .filter(([file]) => file.endsWith(".spec.ts") || file.endsWith(".test.ts"))
    .map(([, content]) => content)
    .join("\n");
  return Math.max((specs.match(/\btest\s*\(/g) || []).length, 1);
}

function scriptLabel(script: Script) {
  const date = script.createdAt ? new Date(script.createdAt).toLocaleString() : script.id.slice(0, 8);
  const appUrl = script.appUrl ? ` - ${shortUrl(script.appUrl)}` : " - no app URL";
  const storage = script.storage === "local" ? "local" : "db";
  return `${script.name}${appUrl} - ${storage} - ${date}`;
}

function shortUrl(value: string) {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value.slice(0, 32);
  }
}

function canStartRun(
  source: "saved" | "inline",
  selectedScriptId: string,
  appUrl: string,
  inlineName: string,
  inlineScriptText: string,
  workerConfigured?: boolean,
) {
  if (!workerConfigured) return false;
  if (source === "saved") return Boolean(selectedScriptId && appUrl);
  return Boolean(inlineName.trim() && appUrl.trim() && inlineScriptText.trim());
}

function readLocalScripts(): Script[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_SCRIPTS_KEY) || "[]") as Script[];
    return Array.isArray(parsed) ? parsed.slice(0, 1).map((script) => ({ ...script, storage: "local" as const, generationWarnings: [] })) : [];
  } catch {
    return [];
  }
}

function clearLocalScriptsOnPageUnload() {
  if (typeof window === "undefined") return;
  const cleanup = () => localStorage.removeItem(LOCAL_SCRIPTS_KEY);
  window.addEventListener("beforeunload", cleanup);
  return () => window.removeEventListener("beforeunload", cleanup);
}

function getRunnableSpec(files: Record<string, string>) {
  return files["tests/generated.spec.ts"] || files["tests/pasted.spec.ts"] || Object.entries(files).find(([file]) => file.endsWith(".spec.ts"))?.[1] || "";
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function detectPastedScriptWarning(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^```json/i.test(trimmed) || /^json\s*\{/i.test(trimmed) || /^\{[\s\S]*"files"\s*:/i.test(trimmed)) {
    return "This looks like a generated JSON wrapper. QA Robot will try to extract the Playwright spec before running.";
  }
  if (!/test\s*\(/.test(trimmed)) {
    return "This does not look like a Playwright test yet. Include a test(...) block before running.";
  }
  return "";
}
