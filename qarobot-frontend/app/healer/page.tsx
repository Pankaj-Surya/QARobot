"use client";

import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost } from "@/lib/api-client";
import { CheckCircle2, FileWarning, LoaderCircle, Play, Save, Sparkles, Wrench, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

type FailedRun = {
  id: string;
  scriptId: string | null;
  status: string;
  browser: string;
  startedAt: string | null;
  completedAt: string | null;
  failedCount: number;
  scriptName: string;
  appUrl: string | null;
  failureSummary: string;
  failureClassification: string;
};

type HealAttempt = {
  attempt: number;
  strategy: "deterministic" | "llm";
  status: "passed" | "failed" | "skipped";
  summary: string;
  rootCause: string;
  brokenSelectors: string[];
  suggestedChanges: string[];
  fixedSpec: string;
  confidence: number;
  validationRunId?: string;
  validationReport?: { artifacts?: ArtifactItem[]; tests?: Array<{ title: string; status: string; error?: string }> };
  artifacts?: ArtifactItem[];
  error?: string;
  warnings: string[];
};

type ArtifactItem = { type: string; name: string; url: string; size: number; path: string };

type HealResponse = {
  run: { id: string; scriptName: string; appUrl: string | null; browser: string };
  originalFailureSummary: string;
  failureClassification: string;
  originalArtifacts: ArtifactItem[];
  pageContext: { mode?: string; warnings?: string[] };
  attempts: HealAttempt[];
  finalStatus: "healed" | "not_healed" | "needs_manual_review";
  fixedSpec: string;
  bestCandidateSpec: string;
  confidence: number;
  validationRunId?: string;
  warnings: string[];
};

type RunStartResponse = { run: { id: string } };
type SaveScriptResponse = { script: { id: string; name: string } };

export default function HealerPage() {
  const [runs, setRuns] = useState<FailedRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [result, setResult] = useState<HealResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCandidates() {
    setError(null);
    setIsLoading(true);
    try {
      const response = await apiGet<{ runs: FailedRun[] }>("/api/healer/candidates");
      setRuns(response.runs);
      if (!selectedRunId && response.runs.length > 0) setSelectedRunId(response.runs[0].id);
    } catch (loadError) {
      setError(readError(loadError));
    } finally {
      setIsLoading(false);
    }
  }

  async function analyzeRun() {
    if (!selectedRunId) return;
    setError(null);
    setMessage(null);
    setResult(null);
    setIsAnalyzing(true);
    try {
      const response = await apiPost<HealResponse>("/api/healer/analyze-and-validate", { runId: selectedRunId, maxAttempts: 3 });
      setResult(response);
      setMessage(response.finalStatus === "healed" ? "Healer validated a passing fix." : "Healer could not prove a fix. Review the attempts.");
    } catch (analyzeError) {
      setError(readError(analyzeError));
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function saveHealedScript() {
    if (!result?.fixedSpec || !result.run.appUrl) return;
    setError(null);
    setMessage(null);
    setIsSaving(true);
    try {
      const response = await apiPost<SaveScriptResponse>("/api/healer/save-script", {
        runId: result.run.id,
        name: `${result.run.scriptName} - healed`,
        appUrl: result.run.appUrl,
        fixedSpec: result.fixedSpec,
      });
      setMessage(`Saved healed script: ${response.script.name}`);
    } catch (saveError) {
      setError(readError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function runHealedScript() {
    if (!result?.fixedSpec || !result.run.appUrl) return;
    setError(null);
    setMessage(null);
    setIsRunning(true);
    try {
      const response = await apiPost<RunStartResponse>("/api/runs/start", {
        source: "inline",
        name: `${result.run.scriptName} - healed validation`,
        appUrl: result.run.appUrl,
        scriptText: result.fixedSpec,
        browser: result.run.browser,
        headed: false,
      });
      setMessage(`Queued healed script run ${response.run.id}. Open Runner to watch logs and artifacts.`);
    } catch (runError) {
      setError(readError(runError));
    } finally {
      setIsRunning(false);
    }
  }

  useEffect(() => {
    loadCandidates();
  }, []);

  const selectedRun = runs.find((run) => run.id === selectedRunId) || null;
  const canUseValidatedFix = result?.finalStatus === "healed" && Boolean(result.fixedSpec && result.run.appUrl);

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Test Healer</h1>
        <p className="mt-1 text-sm text-slate-500">Generate, rerun, and prove Playwright fixes before saving them.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <FileWarning size={17} />
            Failed Runs
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <LoaderCircle className="animate-spin" size={16} />
              Loading failed runs...
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-md border border-line bg-slate-50 p-4 text-sm text-slate-500">
              No failed runner jobs found yet. Run a script, let it fail, then come back here.
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Failed run</span>
                <select className="w-full rounded-md border border-line px-3 py-2" value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}>
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.scriptName} - {run.failureClassification} - {run.startedAt ? new Date(run.startedAt).toLocaleString() : run.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>

              {selectedRun ? (
                <div className="rounded-md border border-line bg-slate-50 p-3 text-sm">
                  <div className="font-medium">{selectedRun.scriptName}</div>
                  <div className="mt-1 break-all text-slate-600">{selectedRun.appUrl || "-"}</div>
                  <div className="mt-2 rounded bg-white px-2 py-1 text-xs font-semibold uppercase text-slate-500">{selectedRun.failureClassification}</div>
                  <div className="mt-2 text-slate-600">{selectedRun.failureSummary}</div>
                </div>
              ) : null}

              <button className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={isAnalyzing || !selectedRunId} onClick={analyzeRun}>
                {isAnalyzing ? <LoaderCircle className="animate-spin" size={16} /> : <Wrench size={16} />}
                Analyze, fix, and validate
              </button>

              <button className="w-full rounded-md border border-line px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={loadCandidates} type="button">
                Refresh failed runs
              </button>
            </div>
          )}
        </section>

        <section className="rounded-md border border-line bg-white">
          <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
            <Sparkles size={17} />
            Validated Healing Result
          </div>

          {!result ? (
            <div className="px-5 py-8 text-sm text-slate-500">
              Select a failed run and click Analyze, fix, and validate.
            </div>
          ) : (
            <div className="space-y-5 p-5">
              <div className="grid gap-3 md:grid-cols-4">
                <Metric label="Final Status" value={statusLabel(result.finalStatus)} positive={result.finalStatus === "healed"} />
                <Metric label="Failure Type" value={result.failureClassification} />
                <Metric label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
                <Metric label="DOM Inspect" value={result.pageContext.mode || "unknown"} />
              </div>

              <InfoBlock title="Original Failure" body={result.originalFailureSummary} />

              <div className="rounded-md border border-line p-4">
                <div className="text-sm font-semibold">Healing Attempts</div>
                <div className="mt-3 space-y-3">
                  {result.attempts.map((attempt) => (
                    <AttemptCard key={attempt.attempt} attempt={attempt} />
                  ))}
                </div>
              </div>

              <ListBlock title="Warnings" items={result.warnings} empty="No warnings." />

              {canUseValidatedFix ? (
                <div className="flex flex-wrap gap-2">
                  <button className="inline-flex items-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={isSaving} onClick={saveHealedScript}>
                    {isSaving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
                    Save healed script
                  </button>
                  <button className="inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60" disabled={isRunning} onClick={runHealedScript}>
                    {isRunning ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}
                    Run healed script
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  QA Robot did not save a fix because no candidate passed validation.
                </div>
              )}

              <div>
                <div className="mb-2 text-sm font-semibold">{canUseValidatedFix ? "Validated Fixed Spec" : "Best Candidate Spec"}</div>
                <pre className="max-h-[520px] overflow-auto rounded-md bg-slate-950 p-4 text-sm text-slate-100">
                  <code>{result.fixedSpec || result.bestCandidateSpec || "No spec candidate available."}</code>
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>

      {message ? <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function AttemptCard({ attempt }: { attempt: HealAttempt }) {
  const passed = attempt.status === "passed";
  const artifacts = attempt.artifacts || attempt.validationReport?.artifacts || [];
  return (
    <div className={`rounded-md border p-3 ${passed ? "border-emerald-200 bg-emerald-50" : "border-line bg-slate-50"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {passed ? <CheckCircle2 className="text-emerald-700" size={16} /> : <XCircle className="text-slate-500" size={16} />}
        <div className="text-sm font-semibold">Attempt {attempt.attempt} - {attempt.strategy} - {attempt.status}</div>
        <div className="rounded bg-white px-2 py-1 text-xs text-slate-600">{Math.round(attempt.confidence * 100)}%</div>
      </div>
      <div className="mt-2 text-sm text-slate-700">{attempt.rootCause}</div>
      {attempt.error ? <div className="mt-2 rounded bg-white p-2 text-xs text-red-700">{attempt.error}</div> : null}
      <ListBlock title="Selectors / Signals" items={attempt.brokenSelectors} empty="No selector signals extracted." compact />
      <ListBlock title="Changes" items={attempt.suggestedChanges} empty="No changes listed." compact />
      {artifacts.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {artifacts.slice(0, 6).map((artifact) => (
            <a key={`${artifact.type}-${artifact.path}`} className="rounded border border-line bg-white px-2 py-1 text-xs hover:bg-slate-50" href={artifact.url} rel="noreferrer" target="_blank">
              {artifact.type}: {artifact.name}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${positive ? "border-emerald-200 bg-emerald-50" : "border-line bg-slate-50"}`}>
      <div className="text-xs font-semibold uppercase text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-line p-4">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-2 text-sm text-slate-600">{body}</div>
    </div>
  );
}

function ListBlock({ title, items, empty, compact }: { title: string; items: string[]; empty: string; compact?: boolean }) {
  const values = items.filter(Boolean);
  return (
    <div className={compact ? "mt-3" : "rounded-md border border-line p-4"}>
      <div className="text-sm font-semibold">{title}</div>
      {values.length === 0 ? (
        <div className="mt-2 text-sm text-slate-500">{empty}</div>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
          {values.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}

function statusLabel(value: HealResponse["finalStatus"]) {
  if (value === "healed") return "Healed";
  if (value === "not_healed") return "Not healed";
  return "Manual review";
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
