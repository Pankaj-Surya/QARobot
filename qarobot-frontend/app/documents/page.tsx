"use client";

import { AppShell } from "@/components/app-shell";
import { MarkdownPreview } from "@/components/markdown-preview";
import { apiDelete, apiGet, apiPost, apiPut, apiUploadWithProgress } from "@/lib/api-client";
import { DatabaseZap, FileText, LoaderCircle, MessageSquare, Send, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type DocumentStatus = "uploading" | "processing" | "indexed" | "failed";

type DocumentRow = {
  id: string;
  name: string;
  fileType: string;
  fileSize: number;
  ragProjectId: string | null;
  ragProjectName?: string | null;
  sourceType: string;
  status: DocumentStatus;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
};

type RagProject = { id: string; name: string; documentCount: number; sourceTypes: string[] };

const sourceTypes = ["requirement", "testcase", "test_plan", "api_spec", "gherkin", "release_note", "support_doc", "general"];

type DocumentDetail = {
  document: DocumentRow & { r2Key: string };
  chunks: Array<{
    id: string;
    chunkIndex: number;
    chunkTextPreview: string;
    fullText: string;
    vectorId: string;
  }>;
};

type AskResponse = {
  question: string;
  answer: string;
  retrieval?: {
    method: string;
    topK: number;
    queryTerms: string[];
    totalCandidateChunks: number;
    candidateChunksAfterHybrid?: number;
    returnedChunks?: number;
    structuredMatchCount?: number;
    queryAnalysis?: {
      intent: string;
      keywords: string[];
      expandedKeywords: string[];
      filters: Array<{ field: string; value: string; sourceText: string; required: boolean }>;
      filterMode: "all" | "any";
      documentSignals: string[];
      requestedOutput: string;
    };
    note: string;
  };
  chunks: Array<{
    documentId: string;
    documentName: string;
    chunkIndex: number;
    score: number;
    structuredScore?: number;
    lexicalScore?: number;
    semanticScore?: number;
    rerankScore?: number;
    matchedTerms: string[];
    matchedMetadataFields?: string[];
    constraintMatchStatus?: string;
    retrievalReason: string;
    preview: string;
  }>;
};

type UploadProgress = {
  percent: number;
  phase: string;
  detail: string;
  startedAt: number;
};

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [projects, setProjects] = useState<RagProject[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [uploadProjectId, setUploadProjectId] = useState("");
  const [uploadSourceType, setUploadSourceType] = useState("general");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [question, setQuestion] = useState("");
  const [askResult, setAskResult] = useState<AskResponse | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [debugRetrieval, setDebugRetrieval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPendingDocuments = useMemo(
    () => documents.some((document) => ["uploading", "processing"].includes(document.status)),
    [documents],
  );

  async function loadDocuments() {
    const [result, projectsResult] = await Promise.all([
      apiGet<{ documents: DocumentRow[] }>("/api/documents"),
      apiGet<{ projects: RagProject[] }>("/api/rag/projects"),
    ]);
    setDocuments(result.documents);
    setProjects(dedupeProjects(projectsResult.projects));
  }

  async function updateDocumentMapping(documentId: string, ragProjectId: string, sourceType: string) {
    if (!ragProjectId) {
      setError("Select a RAG Project. Documents cannot be unassigned.");
      return;
    }
    setError(null);
    try {
      await apiPut(`/api/documents/${documentId}/rag-mapping`, { ragProjectId, sourceType });
      await loadDocuments();
      if (selectedId === documentId) await loadDetail(documentId);
    } catch (mappingError) {
      setError(readError(mappingError));
    }
  }

  async function loadDetail(id: string) {
    try {
      const result = await apiGet<DocumentDetail>(`/api/documents/${id}`);
      setDetail(result);
      setSelectedId(id);
    } catch (detailError) {
      setSelectedId(null);
      setDetail(null);
      await loadDocuments();
      throw detailError;
    }
  }

  useEffect(() => {
    loadDocuments().catch((loadError) => setError(readError(loadError)));
  }, []);

  useEffect(() => {
    if (!hasPendingDocuments) {
      return;
    }

    const interval = window.setInterval(() => {
      loadDocuments().catch((loadError) => setError(readError(loadError)));
    }, 3000);

    return () => window.clearInterval(interval);
  }, [hasPendingDocuments]);

  async function handleUpload(file: File) {
    setError(null);
    setIsUploading(true);
    setUploadProgress({
      percent: 2,
      phase: "Preparing upload",
      detail: `${file.name} (${formatBytes(file.size)})`,
      startedAt: Date.now(),
    });

    let progressTimer: number | undefined;

    try {
      const resolvedProjectId = await ensureUploadProject();
      const formData = new FormData();
      formData.append("ragProjectId", resolvedProjectId);
      formData.append("ragProjectName", selectedUploadProjectName());
      formData.append("sourceType", uploadSourceType);
      formData.append("file", file);
      const uploaded = await apiUploadWithProgress<{
        document: DocumentRow;
        chunksIndexed?: number;
        next: { payload: { documentId: string } } | null;
      }>(
        "/api/documents/upload",
        formData,
        (percent) => {
          setUploadProgress((current) => ({
            percent: Math.max(current?.percent || 0, Math.min(50, 5 + Math.round(percent * 0.45))),
            phase: "Uploading file",
            detail: `${percent}% of file transferred to backend`,
            startedAt: current?.startedAt || Date.now(),
          }));
        },
      );

      setDocuments((current) => [uploaded.document, ...current]);
      setUploadProgress((current) => ({
        percent: 55,
        phase: "Source saved",
        detail: "Upload completed. Starting RAG ingestion pipeline.",
        startedAt: current?.startedAt || Date.now(),
      }));
      await loadDocuments();

      progressTimer = window.setInterval(() => {
        setUploadProgress((current) => {
          if (!current || current.percent >= 92) return current;
          const elapsedSeconds = Math.round((Date.now() - current.startedAt) / 1000);
          const phase =
            current.percent < 70
              ? "Extracting and chunking"
              : current.percent < 84
                ? "Embedding chunks"
                : "Indexing vectors";

          return {
            ...current,
            percent: Math.min(92, current.percent + 3),
            phase,
            detail:
              elapsedSeconds > 60
                ? "Large files can take a few minutes while embeddings are generated. Still working..."
                : "Processing content into searchable RAG evidence.",
          };
        });
      }, 2500);

      if (uploaded.next?.payload) {
        await apiPost("/api/documents/process", uploaded.next.payload);
      }
      if (progressTimer) window.clearInterval(progressTimer);
      setUploadProgress((current) => ({
        percent: 100,
        phase: "Ingestion complete",
        detail: "Chunks and vector references are ready for retrieval.",
        startedAt: current?.startedAt || Date.now(),
      }));
      await loadDetail(uploaded.document.id);
      await loadDocuments();
    } catch (uploadError) {
      setError(readError(uploadError));
      setUploadProgress((current) => ({
        percent: current?.percent || 0,
        phase: "Upload or ingestion failed",
        detail: readError(uploadError),
        startedAt: current?.startedAt || Date.now(),
      }));
    } finally {
      if (progressTimer) window.clearInterval(progressTimer);
      setIsUploading(false);
      window.setTimeout(() => {
        setUploadProgress((current) => (current?.phase === "Ingestion complete" ? null : current));
      }, 3500);
    }
  }

  function selectedUploadProjectName() {
    return projects.find((project) => project.id === uploadProjectId)?.name || newProjectName.trim();
  }

  async function ensureUploadProject() {
    if (uploadProjectId) return uploadProjectId;

    const projectName = newProjectName.trim();
    if (!projectName) {
      throw new Error("Select an existing RAG Project or enter a new RAG Project name before uploading.");
    }

    const existing = projects.find((project) => project.name.trim().toLowerCase() === projectName.toLowerCase());
    if (existing) {
      setUploadProjectId(existing.id);
      setNewProjectName("");
      return existing.id;
    }

    const result = await apiPost<{ project: RagProject }>("/api/rag/projects", {
      name: projectName,
      aliases: [projectName],
    });
    const project = { ...result.project, documentCount: 0, sourceTypes: [] };
    setProjects((current) => dedupeProjects([project, ...current]));
    setUploadProjectId(project.id);
    setNewProjectName("");
    return project.id;
  }

  async function askDocuments() {
    setError(null);
    setIsAsking(true);

    try {
      const result = await apiPost<AskResponse>("/api/documents/ask", {
        question,
        topK: 6,
        debug: debugRetrieval,
      });
      setAskResult(result);
    } catch (askError) {
      setError(readError(askError));
    } finally {
      setIsAsking(false);
    }
  }

  async function rebuildIngestion() {
    const confirmed = window.confirm(
      "Rebuild ingestion for all uploaded documents? This clears existing chunks and vectors, then recreates them from stored files.",
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    setIsRebuilding(true);

    try {
      await apiPost("/api/documents/ingestion/rebuild", {});
      await loadDocuments();
      if (selectedId) {
        await loadDetail(selectedId);
      }
    } catch (rebuildError) {
      setError(readError(rebuildError));
    } finally {
      setIsRebuilding(false);
    }
  }

  async function deleteDocument(document: DocumentRow) {
    const confirmed = window.confirm(
      `Delete ${document.name}? This removes the uploaded file, RAG chunks, and vector references for this source. Saved generated outputs are not deleted.`,
    );
    if (!confirmed) return;

    setError(null);
    setDeletingDocumentId(document.id);

    try {
      await apiDelete(`/api/documents/${document.id}`);
      if (selectedId === document.id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadDocuments();
    } catch (deleteError) {
      setError(readError(deleteError));
    } finally {
      setDeletingDocumentId(null);
    }
  }

  async function deleteAllDocuments() {
    const confirmed = window.confirm(
      "Delete all uploads? This removes all uploaded files, all RAG chunks, and all vector references. Saved generated outputs are not deleted.",
    );
    if (!confirmed) return;

    setError(null);
    setDeletingDocumentId("all");

    try {
      await apiDelete("/api/documents");
      setSelectedId(null);
      setDetail(null);
      setAskResult(null);
      await loadDocuments();
    } catch (deleteError) {
      setError(readError(deleteError));
    } finally {
      setDeletingDocumentId(null);
    }
  }

  return (
    <AppShell>
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Documents</h1>
          <p className="mt-1 text-sm text-slate-500">Upload source material into the ingestion-retrieval RAG pipeline.</p>
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
            disabled={isRebuilding || documents.length === 0}
            onClick={rebuildIngestion}
          >
            {isRebuilding ? <LoaderCircle className="animate-spin" size={16} /> : <DatabaseZap size={16} />}
            Rebuild ingestion
          </button>
          <button
            className="flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
            disabled={deletingDocumentId === "all" || documents.length === 0}
            onClick={deleteAllDocuments}
          >
            {deletingDocumentId === "all" ? <LoaderCircle className="animate-spin" size={16} /> : <Trash2 size={16} />}
            Delete all uploads
          </button>
        </div>
      </div>
      <section className="rounded-md border border-line bg-white p-4">
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)_220px] md:items-end">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">RAG Project</span>
            <select className="w-full rounded-md border border-line px-3 py-2" value={uploadProjectId} onChange={(event) => { setUploadProjectId(event.target.value); if (event.target.value) setNewProjectName(""); }}>
              <option value="">Use new project name</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">New project name</span>
            <input className="w-full rounded-md border border-line px-3 py-2" value={newProjectName} onChange={(event) => { setNewProjectName(event.target.value); if (event.target.value.trim()) setUploadProjectId(""); }} placeholder="Example: BStackDemo" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Source type</span>
            <select className="w-full rounded-md border border-line px-3 py-2" value={uploadSourceType} onChange={(event) => setUploadSourceType(event.target.value)}>
              {sourceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-2 text-xs text-slate-500">Select an existing project or type a new project name. Upload will use that project and then run the RAG ingestion pipeline.</div>

        <label className={`mt-4 block rounded-md border border-dashed p-8 text-center transition ${uploadProjectId || newProjectName.trim() ? "border-slate-300 hover:border-action" : "border-amber-200 bg-amber-50"}`}>
          {isUploading ? (
            <LoaderCircle className="mx-auto mb-3 animate-spin text-action" size={28} />
          ) : (
            <Upload className="mx-auto mb-3 text-action" size={28} />
          )}
          <div className="text-sm font-medium">{isUploading ? "Uploading document" : "Upload document to selected RAG Project"}</div>
          <p className="mt-2 text-sm text-slate-500">
            Project: {selectedUploadProjectName() || "not selected"} - Source type: {uploadSourceType}
          </p>
          {!uploadProjectId && !newProjectName.trim() ? <p className="mt-2 text-sm font-medium text-amber-700">Select a RAG Project or enter a new project name before uploading.</p> : null}
          <input
            className="sr-only"
            type="file"
            disabled={isUploading || (!uploadProjectId && !newProjectName.trim())}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                handleUpload(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
      </section>

      {uploadProgress ? (
        <div className="mt-4 rounded-md border border-line bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold">{uploadProgress.phase}</div>
              <div className="mt-1 text-xs text-slate-500">{uploadProgress.detail}</div>
            </div>
            <div className="text-sm font-semibold text-slate-700">{uploadProgress.percent}%</div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-action transition-all"
              style={{ width: `${uploadProgress.percent}%` }}
            />
          </div>
          {isUploading ? (
            <div className="mt-2 text-xs text-slate-500">
              Current pipeline: upload {"->"} store source {"->"} extract text {"->"} chunk rows/sections {"->"} generate embeddings {"->"} index vectors.
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-hidden rounded-md border border-line bg-white">
          <div className="grid grid-cols-[minmax(0,1fr)_150px_130px_100px_80px_70px] border-b border-line px-4 py-3 text-xs font-medium uppercase text-slate-500">
            <span>Name</span>
            <span>RAG Project</span>
            <span>Source Type</span>
            <span>Status</span>
            <span>Chunks</span>
            <span></span>
          </div>
          {documents.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No documents indexed yet.</div>
          ) : (
            documents.map((document) => (
              <div
                key={document.id}
                className="grid w-full grid-cols-[minmax(0,1fr)_150px_130px_100px_80px_70px] items-center gap-2 border-b border-line px-4 py-3 text-left text-sm last:border-0 hover:bg-slate-50"
              >
                <button
                  className="flex min-w-0 items-center gap-2 text-left"
                  onClick={() => loadDetail(document.id).catch((detailError) => setError(readError(detailError)))}
                >
                  <FileText className="shrink-0 text-slate-400" size={16} />
                  <span className="truncate font-medium">{document.name}</span>
                </button>
                <select
                  className="min-w-0 rounded-md border border-line px-2 py-1 text-xs"
                  value={document.ragProjectId || ""}
                  onChange={(event) => updateDocumentMapping(document.id, event.target.value, document.sourceType)}
                >
                  <option value="">Select project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <select
                  className="min-w-0 rounded-md border border-line px-2 py-1 text-xs"
                  value={document.sourceType || "general"}
                  onChange={(event) => updateDocumentMapping(document.id, document.ragProjectId || "", event.target.value)}
                >
                  {sourceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <StatusBadge status={document.status} />
                <span>{document.chunkCount}</span>
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                  disabled={deletingDocumentId === document.id}
                  onClick={() => deleteDocument(document)}
                  title="Delete uploaded source"
                >
                  {deletingDocumentId === document.id ? <LoaderCircle className="animate-spin" size={14} /> : <Trash2 size={14} />}
                </button>
              </div>
            ))
          )}
        </div>

        <aside className="rounded-md border border-line bg-white p-4">
          <div className="mb-3 text-sm font-semibold">Preview</div>
          {!selectedId || !detail ? (
            <div className="text-sm text-slate-500">Select ingested source material to inspect its chunks.</div>
          ) : (
            <div>
              <div className="mb-3 text-sm font-medium">{detail.document.name}</div>
              <div className="space-y-3">
                {detail.chunks.slice(0, 5).map((chunk) => (
                  <div key={chunk.id} className="rounded-md border border-line p-3">
                    <div className="mb-1 text-xs font-medium text-slate-500">Chunk {chunk.chunkIndex + 1}</div>
                    <p className="line-clamp-4 text-sm text-slate-700">{chunk.fullText}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      <section className="mt-5 rounded-md border border-line bg-white">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          <MessageSquare size={17} />
          Ask RAG Pipeline
        </div>
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-slate-700" htmlFor="rag-question">
              Question
            </label>
            <textarea
              id="rag-question"
              className="mt-2 h-32 w-full rounded-md border border-line p-3 text-sm"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask for login related test cases, exact requirements, acceptance criteria, or edge cases"
            />
            <div className="mt-2 text-xs text-slate-500">
              Searches the full ingested knowledge base. Selecting source material only changes the preview panel.
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={debugRetrieval}
                onChange={(event) => setDebugRetrieval(event.target.checked)}
              />
              Show retrieval debug details
            </label>
            <button
              className="mt-4 flex items-center justify-center gap-2 rounded-md bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={isAsking || !question.trim()}
              onClick={askDocuments}
            >
              {isAsking ? <LoaderCircle className="animate-spin" size={16} /> : <Send size={16} />}
              Ask
            </button>
          </div>

          <div className="min-h-56 min-w-0 overflow-hidden rounded-md border border-line">
            {!askResult ? (
              <div className="p-4 text-sm text-slate-500">
                Ask a question to see the answer, top-K retrieval method, matched terms, scores, and source chunks.
              </div>
            ) : (
              <div className="max-h-[72vh] min-w-0 overflow-auto p-4">
                <MarkdownPreview content={askResult.answer} />
                {askResult.retrieval ? (
                  <details className="mt-4 rounded-md border border-line p-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700">Retrieval details</summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <Metric label="Method" value={askResult.retrieval.method} />
                      <Metric label="Top K" value={String(askResult.retrieval.topK)} />
                      <Metric label="Candidates" value={String(askResult.retrieval.totalCandidateChunks)} />
                      <Metric label="Structured" value={String(askResult.retrieval.structuredMatchCount || 0)} />
                      <Metric label="Returned" value={String(askResult.retrieval.returnedChunks || askResult.chunks.length)} />
                      <Metric label="Intent" value={askResult.retrieval.queryAnalysis?.intent || "-"} />
                    </div>
                    {askResult.retrieval.queryAnalysis ? (
                      <div className="mt-4 rounded-md border border-line bg-slate-50 p-3 text-xs text-slate-600">
                        <div>Keywords: {askResult.retrieval.queryAnalysis.keywords.join(", ") || "none"}</div>
                        <div className="mt-1">
                          Filters:{" "}
                          {askResult.retrieval.queryAnalysis.filters
                            .map((filter) => `${filter.field}=${filter.value}`)
                            .join(", ") || "none"}
                          {askResult.retrieval.queryAnalysis.filters.length > 1
                            ? ` (${askResult.retrieval.queryAnalysis.filterMode})`
                            : ""}
                        </div>
                        <div className="mt-1">
                          Signals: {askResult.retrieval.queryAnalysis.documentSignals.join(", ") || "none"}
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-4 space-y-2">
                      {askResult.chunks.map((chunk) => (
                        <div key={`${chunk.documentId}-${chunk.chunkIndex}`} className="rounded-md border border-line p-3">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span>{chunk.documentName}</span>
                            <span>Chunk {chunk.chunkIndex + 1}</span>
                            <span>Score {chunk.score}</span>
                            {chunk.constraintMatchStatus ? <span>Filter {chunk.constraintMatchStatus}</span> : null}
                          </div>
                          <p className="text-sm text-slate-700">{chunk.preview}</p>
                          <div className="mt-2 text-xs text-slate-500">
                            Matched: {chunk.matchedTerms.join(", ") || "none"}
                          </div>
                          {chunk.matchedMetadataFields?.length ? (
                            <div className="mt-1 text-xs text-slate-500">
                              Metadata: {chunk.matchedMetadataFields.join(", ")}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </section>
    </AppShell>
  );
}

function StatusBadge({ status }: { status: DocumentStatus }) {
  const className =
    status === "indexed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failed"
        ? "bg-red-50 text-red-700"
        : "bg-amber-50 text-amber-700";

  return <span className={`w-fit rounded px-2 py-1 text-xs font-medium ${className}`}>{status}</span>;
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function dedupeProjects(projects: RagProject[]) {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = project.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}
