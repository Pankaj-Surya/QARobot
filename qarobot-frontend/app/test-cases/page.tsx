"use client";

import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost } from "@/lib/api-client";
import { LoaderCircle, Save, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

type TestCase = {
  id?: string;
  tcId?: string;
  title: string;
  module: string;
  testType: string;
  priority: string;
  preconditions?: string | null;
  steps: string[];
  testData?: string | null;
  expectedResult: string;
  automationStatus?: string;
};

type RagProject = { id: string; name: string; sourceTypes: string[]; documentCount: number };
type RagUsage = { mode: "used" | "skipped" | "ambiguous"; reason: string; projectName: string | null; sourceTypes: string[]; appUrl: string | null };
type LiveAppContext = { mode: string; title?: string; finalUrl?: string; warnings?: string[] };

const TEST_CASES_CHANGED_KEY = "qarobot.testCasesChanged";

export default function TestCasesPage() {
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [projects, setProjects] = useState<RagProject[]>([]);
  const [draftCases, setDraftCases] = useState<TestCase[]>([]);
  const [featureDescription, setFeatureDescription] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [ragProjectId, setRagProjectId] = useState("");
  const [ragUsage, setRagUsage] = useState<RagUsage | null>(null);
  const [liveAppContext, setLiveAppContext] = useState<LiveAppContext | null>(null);
  const [requirementProvider, setRequirementProvider] = useState<"jira" | "azure_boards">("jira");
  const [requirementKey, setRequirementKey] = useState("");
  const [isFetchingRequirement, setIsFetchingRequirement] = useState(false);
  const [count, setCount] = useState(5);
  const [mode, setMode] = useState("balanced");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    const [casesResult, projectsResult] = await Promise.all([
      apiGet<{ testCases: TestCase[] }>("/api/test-cases"),
      apiGet<{ projects: RagProject[] }>("/api/rag/projects"),
    ]);
    setTestCases(casesResult.testCases);
    setProjects(projectsResult.projects);
  }

  useEffect(() => {
    loadData().catch((loadError) => setError(readError(loadError)));
  }, []);

  async function generateCases() {
    setError(null);
    setMessage(null);
    setIsGenerating(true);

    try {
      const result = await apiPost<{ cases: TestCase[]; ragUsage: RagUsage; liveAppContext: LiveAppContext | null }>("/api/test-cases/generate", {
        featureDescription,
        appUrl: appUrl.trim() || undefined,
        ragProjectId: ragProjectId || undefined,
        count,
        mode,
      });
      setDraftCases(result.cases);
      setRagUsage(result.ragUsage);
      setLiveAppContext(result.liveAppContext);
      setMessage(result.ragUsage.mode === "used" ? "Draft test cases generated from matched RAG Project evidence." : result.ragUsage.reason);
    } catch (generateError) {
      setError(readError(generateError));
    } finally {
      setIsGenerating(false);
    }
  }

  async function fetchRequirement() {
    if (!requirementKey.trim()) return;
    setError(null);
    setMessage(null);
    setIsFetchingRequirement(true);
    try {
      const result = await apiPost<{ requirement: { text: string } }>(`/api/models/integrations/${requirementProvider}/fetch-requirement`, { key: requirementKey.trim() });
      setFeatureDescription(result.requirement.text);
      setMessage(`Fetched requirement from ${requirementProvider === "jira" ? "Jira" : "Azure Boards"}.`);
    } catch (fetchError) {
      setError(readError(fetchError));
    } finally {
      setIsFetchingRequirement(false);
    }
  }

  async function saveCases() {
    setError(null);
    setMessage(null);
    setIsSaving(true);

    try {
      const result = await apiPost<{ testCases: TestCase[] }>("/api/test-cases/save", { cases: draftCases });
      localStorage.setItem(TEST_CASES_CHANGED_KEY, String(Date.now()));
      setDraftCases([]);
      setTestCases((current) => [...result.testCases, ...current.filter((testCase) => !result.testCases.some((saved) => saved.id === testCase.id))]);
      setMessage("Selected test cases saved.");
      await loadData();
    } catch (saveError) {
      setError(readError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Test Cases</h1>
        <p className="mt-1 text-sm text-slate-500">Generate Jira-ready cases from a feature requirement and RAG pipeline retrieval.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Feature description</span>
              <textarea
                className="h-32 w-full rounded-md border border-line p-3"
                value={featureDescription}
                onChange={(event) => setFeatureDescription(event.target.value)}
                placeholder="Example: Generate login test cases for valid, invalid, 2FA, and forgot password flows"
              />
              <span className="mt-2 block text-xs text-slate-500">
                The feature description is the requirement. The backend retrieves relevant evidence from the ingested knowledge base before calling the selected LLM.
              </span>
            </label>
            <div className="rounded-md border border-line p-3">
              <div className="mb-2 text-sm font-medium">Fetch requirement optional</div>
              <div className="grid gap-2 md:grid-cols-[130px_minmax(0,1fr)]">
                <select className="rounded-md border border-line px-3 py-2 text-sm" value={requirementProvider} onChange={(event) => setRequirementProvider(event.target.value as "jira" | "azure_boards")}>
                  <option value="jira">Jira</option>
                  <option value="azure_boards">Azure Boards</option>
                </select>
                <input className="rounded-md border border-line px-3 py-2 text-sm" value={requirementKey} onChange={(event) => setRequirementKey(event.target.value)} placeholder="Issue key or work item ID" />
              </div>
              <button className="mt-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60" disabled={isFetchingRequirement || !requirementKey.trim()} onClick={fetchRequirement} type="button">
                {isFetchingRequirement ? "Fetching..." : "Fetch into requirement"}
              </button>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">App URL optional</span>
              <input
                className="w-full rounded-md border border-line px-3 py-2"
                value={appUrl}
                onChange={(event) => setAppUrl(event.target.value)}
                placeholder="https://your-app.example.com"
              />
              <span className="mt-2 block text-xs text-slate-500">Helps match the right RAG Project. Leave blank when generating only from requirement or selected project.</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">RAG Project</span>
              <select className="w-full rounded-md border border-line px-3 py-2" value={ragProjectId} onChange={(event) => setRagProjectId(event.target.value)}>
                <option value="">Auto / requirement only if no safe match</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.documentCount})
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Count</span>
                <input className="w-full rounded-md border border-line px-3 py-2" type="number" min={1} max={20} value={count} onChange={(event) => setCount(Number(event.target.value))} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Mode</span>
                <select className="w-full rounded-md border border-line px-3 py-2" value={mode} onChange={(event) => setMode(event.target.value)}>
                  <option value="balanced">Balanced</option>
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                  <option value="regression">Regression</option>
                </select>
              </label>
            </div>
            <button className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={isGenerating || !featureDescription.trim()} onClick={generateCases}>
              {isGenerating ? <LoaderCircle className="animate-spin" size={16} /> : <Wand2 size={16} />}
              Generate cases
            </button>
          </div>
        </section>

        <section className="rounded-md border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div className="text-sm font-semibold">{draftCases.length > 0 ? "Generated Preview" : "Saved Test Cases"}</div>
            {draftCases.length > 0 ? (
              <button className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60" disabled={isSaving} onClick={saveCases}>
                {isSaving ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />}
                Save
              </button>
            ) : null}
          </div>
          {draftCases.length > 0 && ragUsage ? <RagUsageBanner usage={ragUsage} /> : null}
          {draftCases.length > 0 && liveAppContext ? <LiveAppBanner context={liveAppContext} /> : null}
          <TestCaseTable cases={draftCases.length > 0 ? draftCases : testCases} />
        </section>
      </div>

      {message ? <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function RagUsageBanner({ usage }: { usage: RagUsage }) {
  return (
    <div className={`border-b border-line px-5 py-3 text-sm ${usage.mode === "used" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
      <div className="font-semibold">{usage.mode === "used" ? `RAG used: ${usage.projectName}` : "RAG skipped"}</div>
      <div className="mt-1">{usage.reason}</div>
      {usage.sourceTypes.length > 0 ? <div className="mt-1 text-xs">Source types: {usage.sourceTypes.join(", ")}</div> : null}
    </div>
  );
}

function LiveAppBanner({ context }: { context: LiveAppContext }) {
  return (
    <div className={`border-b border-line px-5 py-3 text-sm ${context.mode === "external_browser" ? "bg-blue-50 text-blue-800" : "bg-slate-50 text-slate-700"}`}>
      <div className="font-semibold">Live app context: {context.mode === "external_browser" ? "browser inspection" : context.mode}</div>
      <div className="mt-1">{context.title || context.finalUrl || "App URL was inspected for generation context."}</div>
      {context.warnings?.length ? <div className="mt-1 text-xs">{context.warnings.join(" ")}</div> : null}
    </div>
  );
}

function TestCaseTable({ cases }: { cases: TestCase[] }) {
  if (cases.length === 0) {
    return <div className="px-5 py-8 text-sm text-slate-500">No test cases yet.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[1100px] divide-y divide-line">
        <thead className="bg-slate-50">
          <tr>
            {["ID", "Title", "Module", "Priority", "Type", "Steps", "Expected"].map((heading) => (
              <th key={heading} className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-500">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {cases.map((testCase, index) => (
            <tr key={testCase.id || index}>
              <td className="px-3 py-2 text-sm">{testCase.tcId || "-"}</td>
              <td className="max-w-sm px-3 py-2 text-sm font-medium">{testCase.title}</td>
              <td className="px-3 py-2 text-sm">{testCase.module}</td>
              <td className="px-3 py-2 text-sm">{testCase.priority}</td>
              <td className="px-3 py-2 text-sm">{testCase.testType}</td>
              <td className="max-w-md px-3 py-2 text-sm">{testCase.steps.join(" | ")}</td>
              <td className="max-w-sm px-3 py-2 text-sm">{testCase.expectedResult}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
