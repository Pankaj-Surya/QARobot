"use client";

import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost } from "@/lib/api-client";
import { FileWarning, LoaderCircle, Sparkles, Wrench } from "lucide-react";
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
};

type HealSuggestion = {
  summary: string;
  rootCause: string;
  brokenSelectors: string[];
  suggestedChanges: string[];
  fixedSpec: string;
  confidence: number;
  warnings: string[];
  usedModel: boolean;
};

type HealResponse = {
  suggestion: HealSuggestion;
  run: { id: string; scriptName: string; appUrl: string | null; browser: string };
  pageContext: { mode?: string; warnings?: string[] };
};

export default function HealerPage() {
  const [runs, setRuns] = useState<FailedRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [result, setResult] = useState<HealResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
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
    setResult(null);
    setIsAnalyzing(true);
    try {
      const response = await apiPost<HealResponse>("/api/healer/analyze", { runId: selectedRunId });
      setResult(response);
    } catch (analyzeError) {
      setError(readError(analyzeError));
    } finally {
      setIsAnalyzing(false);
    }
  }

  useEffect(() => {
    loadCandidates();
  }, []);

  const selectedRun = runs.find((run) => run.id === selectedRunId) || null;

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Test Healer</h1>
        <p className="mt-1 text-sm text-slate-500">Analyze failed Playwright runs, inspect the current app page, and generate a fixed simple spec proposal.</p>
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
                      {run.scriptName} - {run.browser} - {run.startedAt ? new Date(run.startedAt).toLocaleString() : run.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>

              {selectedRun ? (
                <div className="rounded-md border border-line bg-slate-50 p-3 text-sm">
                  <div className="font-medium">{selectedRun.scriptName}</div>
                  <div className="mt-1 break-all text-slate-600">{selectedRun.appUrl || "-"}</div>
                  <div className="mt-2 text-slate-600">{selectedRun.failureSummary}</div>
                </div>
              ) : null}

              <button className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={isAnalyzing || !selectedRunId} onClick={analyzeRun}>
                {isAnalyzing ? <LoaderCircle className="animate-spin" size={16} /> : <Wrench size={16} />}
                Analyze and heal
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
            Healing Result
          </div>

          {!result ? (
            <div className="px-5 py-8 text-sm text-slate-500">
              Select a failed run and click Analyze and heal.
            </div>
          ) : (
            <div className="space-y-5 p-5">
              <div className="grid gap-3 md:grid-cols-3">
                <Metric label="Mode" value={result.suggestion.usedModel ? "LLM + DOM" : "Fallback"} />
                <Metric label="Confidence" value={`${Math.round(result.suggestion.confidence * 100)}%`} />
                <Metric label="DOM Inspect" value={result.pageContext.mode || "unknown"} />
              </div>

              <InfoBlock title="Summary" body={result.suggestion.summary} />
              <InfoBlock title="Likely Root Cause" body={result.suggestion.rootCause} />

              <ListBlock title="Broken Selectors / Signals" items={result.suggestion.brokenSelectors} empty="No exact broken selector was extracted from the run output." />
              <ListBlock title="Suggested Changes" items={result.suggestion.suggestedChanges} empty="No changes suggested yet." />
              <ListBlock title="Warnings" items={[...result.suggestion.warnings, ...(result.pageContext.warnings || [])]} empty="No warnings." />

              <div>
                <div className="mb-2 text-sm font-semibold">Fixed Spec Proposal</div>
                <pre className="max-h-[520px] overflow-auto rounded-md bg-slate-950 p-4 text-sm text-slate-100">
                  <code>{result.suggestion.fixedSpec}</code>
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>

      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-slate-50 p-3">
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

function ListBlock({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  const values = items.filter(Boolean);
  return (
    <div className="rounded-md border border-line p-4">
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

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
