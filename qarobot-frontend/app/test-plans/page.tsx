"use client";

import { AppShell } from "@/components/app-shell";
import { MarkdownPreview } from "@/components/markdown-preview";
import { apiGet, apiPost } from "@/lib/api-client";
import { Edit3, LoaderCircle, Save, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

type TestPlan = {
  id: string;
  name: string;
  scopeDescription: string;
  content: string;
  createdAt: string;
};

export default function TestPlansPage() {
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [name, setName] = useState("QA Test Plan");
  const [scope, setScope] = useState("");
  const [draft, setDraft] = useState("");
  const [draftMode, setDraftMode] = useState<"preview" | "edit">("preview");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    const plansResult = await apiGet<{ plans: TestPlan[] }>("/api/test-plans");
    setPlans(plansResult.plans);
  }

  useEffect(() => {
    loadData().catch((loadError) => setError(readError(loadError)));
  }, []);

  async function generatePlan() {
    setError(null);
    setMessage(null);
    setIsGenerating(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/test-plans/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, scope }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setDraft(await response.text());
      setDraftMode("preview");
      setMessage("Draft generated from the current scope and retrieved RAG evidence.");
    } catch (generateError) {
      setError(readError(generateError));
    } finally {
      setIsGenerating(false);
    }
  }

  async function savePlan() {
    setError(null);
    setMessage(null);
    setIsSaving(true);

    try {
      await apiPost("/api/test-plans/save", {
        name,
        scopeDescription: scope,
        content: draft,
        aiModelUsed: "rag-pipeline-llm",
        sourceDocumentIds: [],
      });
      setMessage("Test plan saved.");
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
        <h1 className="text-xl font-semibold">Test Plan Generator</h1>
        <p className="mt-1 text-sm text-slate-500">Generate a reviewable draft from scope and RAG pipeline retrieval.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section className="rounded-md border border-line bg-white p-5">
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Plan name</span>
              <input className="w-full rounded-md border border-line px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Scope</span>
              <textarea
                className="h-36 w-full rounded-md border border-line p-3"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder="Describe the feature, workflow, or release to test"
              />
            </label>

            <div className="rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-slate-600">
              The backend retrieves relevant evidence from the ingested knowledge base before calling the selected LLM.
            </div>

            <button
              className="flex w-full items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={isGenerating || !scope.trim()}
              onClick={generatePlan}
            >
              {isGenerating ? <LoaderCircle className="animate-spin" size={16} /> : <Wand2 size={16} />}
              Generate draft
            </button>
          </div>
        </section>

        <section className="rounded-md border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div className="text-sm font-semibold">Draft</div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border border-line p-1">
                <button
                  className={`rounded px-3 py-1.5 text-sm ${draftMode === "preview" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                  onClick={() => setDraftMode("preview")}
                >
                  Preview
                </button>
                <button
                  className={`flex items-center gap-1 rounded px-3 py-1.5 text-sm ${draftMode === "edit" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                  onClick={() => setDraftMode("edit")}
                >
                  <Edit3 size={14} />
                  Edit
                </button>
              </div>
              <button
                className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
                disabled={isSaving || !draft.trim()}
                onClick={savePlan}
              >
                {isSaving ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />}
                Save
              </button>
            </div>
          </div>
          {draftMode === "preview" ? (
            <div className="h-[520px] overflow-auto p-5">
              <MarkdownPreview content={draft} emptyText="Generated plan preview appears here." />
            </div>
          ) : (
            <textarea
              className="h-[520px] w-full resize-none p-5 font-mono text-sm outline-none"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Generated plan draft appears here"
            />
          )}
        </section>
      </div>

      <section className="mt-5 rounded-md border border-line bg-white">
        <div className="border-b border-line px-5 py-4 text-sm font-semibold">Saved Plans</div>
        {plans.length === 0 ? (
          <div className="px-5 py-8 text-sm text-slate-500">No saved plans yet.</div>
        ) : (
          <div className="divide-y divide-line">
            {plans.map((plan) => (
              <button
                key={plan.id}
                className="block w-full px-5 py-4 text-left hover:bg-slate-50"
                onClick={() => {
                  setName(plan.name);
                  setScope(plan.scopeDescription);
                  setDraft(plan.content);
                  setDraftMode("preview");
                }}
              >
                <div className="text-sm font-semibold">{plan.name}</div>
                <div className="mt-1 text-xs text-slate-500">{new Date(plan.createdAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        )}
      </section>

      {message ? <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
    </AppShell>
  );
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
