import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { documentChunks, documents, ragProjects } from "../db/schema.js";

export const sourceTypes = [
  "requirement",
  "testcase",
  "test_plan",
  "api_spec",
  "gherkin",
  "release_note",
  "support_doc",
  "general",
] as const;

export type SourceType = (typeof sourceTypes)[number];

export type RagUsage =
  | {
      mode: "used";
      reason: string;
      projectId: string;
      projectName: string;
      sourceTypes: string[];
      appUrl: string | null;
      matchedBy: "selected_project" | "app_url" | "requirement";
    }
  | {
      mode: "skipped";
      reason: string;
      projectId: null;
      projectName: null;
      sourceTypes: string[];
      appUrl: string | null;
      matchedBy: "none";
    }
  | {
      mode: "ambiguous";
      reason: string;
      projectId: null;
      projectName: null;
      sourceTypes: string[];
      appUrl: string | null;
      matchedBy: "requirement";
      candidates: Array<{ id: string; name: string; score: number; reason: string }>;
    };

export async function listRagProjects() {
  const projects = await db.select().from(ragProjects).orderBy(desc(ragProjects.updatedAt), desc(ragProjects.createdAt));
  const counts = await db
    .select({
      id: documents.ragProjectId,
      sourceType: documents.sourceType,
    })
    .from(documents);

  return projects.map((project) => {
    const docs = counts.filter((row) => row.id === project.id);
    return {
      ...project,
      documentCount: docs.length,
      sourceTypes: Array.from(new Set(docs.map((row) => row.sourceType).filter(Boolean))),
    };
  });
}

export async function resolveRagProject(input: {
  ragProjectId?: string | null;
  appUrl?: string | null;
  requirementText: string;
}): Promise<{ documentIds: string[]; usage: RagUsage }> {
  const projects = await listRagProjects();
  const appHost = normalizeHost(input.appUrl || "");

  if (input.ragProjectId) {
    const project = projects.find((item) => item.id === input.ragProjectId);
    if (!project) {
      return skipped(input.appUrl, `Selected RAG Project was not found.`);
    }

    return projectUsage(project, input.appUrl, "selected_project", "Selected RAG Project was used.");
  }

  if (appHost) {
    const matched = projects.find((project) => projectMatchesHost(project, appHost));
    if (matched) {
      return projectUsage(matched, input.appUrl, "app_url", `App URL matched RAG Project "${matched.name}".`);
    }

    return skipped(
      input.appUrl,
      `No RAG Project is mapped to ${appHost}. Generated from requirement and live app context only.`,
    );
  }

  const suggestions = await suggestRagProjects(input.requirementText, 3);
  const strong = suggestions.filter((item) => item.score >= 6);
  if (strong.length === 1) {
    const project = projects.find((item) => item.id === strong[0].id);
    if (project) {
      return projectUsage(project, null, "requirement", `Requirement text matched RAG Project "${project.name}".`);
    }
  }

  if (strong.length > 1) {
    return {
      documentIds: [],
      usage: {
        mode: "ambiguous",
        reason: "Multiple RAG Projects match this request. Select one project before generation.",
        projectId: null,
        projectName: null,
        sourceTypes: [],
        appUrl: null,
        matchedBy: "requirement",
        candidates: strong,
      },
    };
  }

  return skipped(null, "No matching RAG Project found. Output generated from requirement only.");
}

export async function suggestRagProjects(query: string, limit = 5) {
  const projects = await listRagProjects();
  const rows = await db
    .select({
      projectId: documents.ragProjectId,
      documentName: documents.name,
      sourceType: documents.sourceType,
      chunkText: documentChunks.fullText,
      metadata: documentChunks.metadata,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId));

  const terms = tokenize(query);
  const scored = projects
    .map((project) => {
      const projectRows = rows.filter((row) => row.projectId === project.id);
      const projectText = [
        project.name,
        project.description || "",
        ...(project.domains || []),
        ...(project.aliases || []),
        ...projectRows.map((row) => `${row.documentName} ${row.sourceType} ${metadataText(row.metadata)} ${row.chunkText.slice(0, 600)}`),
      ]
        .join(" ")
        .toLowerCase();
      const score = terms.reduce((total, term) => total + (projectText.includes(term) ? 2 : 0), 0);
      const aliasScore = [...(project.aliases || []), ...(project.domains || [])].some((alias) =>
        query.toLowerCase().includes(alias.toLowerCase()),
      )
        ? 6
        : 0;
      return {
        id: project.id,
        name: project.name,
        score: score + aliasScore,
        reason: aliasScore > 0 ? "matched project alias/domain" : "matched requirement terms in project knowledge",
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return scored;
}

export async function inferDocumentMapping(input: { fileName: string; text: string; sourceType?: SourceType }) {
  const domains = extractDomains(`${input.fileName}\n${input.text}`).map(normalizeHost).filter(Boolean);
  const projects = await listRagProjects();
  const matched = domains.length > 0 ? projects.find((project) => domains.some((domain) => projectMatchesHost(project, domain))) : null;
  return {
    ragProjectId: matched?.id || null,
    sourceType: input.sourceType || inferSourceType(input.fileName, input.text),
    detectedDomains: domains,
  };
}

export function inferSourceType(fileName: string, text: string): SourceType {
  const combined = `${fileName}\n${text.slice(0, 2000)}`.toLowerCase();
  if (fileName.toLowerCase().endsWith(".feature")) return "gherkin";
  if (/openapi|swagger|postman|endpoint|operationid/.test(combined)) return "api_spec";
  if (/test\s*case|testcase|expected result|preconditions|priority/.test(combined)) return "testcase";
  if (/test plan|entry criteria|exit criteria|test strategy|test environment/.test(combined)) return "test_plan";
  if (/prd|product requirement|functional requirement|acceptance criteria|user story/.test(combined)) return "requirement";
  if (/release note|changelog|release/.test(combined)) return "release_note";
  if (/support|faq|troubleshoot|help center/.test(combined)) return "support_doc";
  if (/requirement|shall|must|should/.test(combined)) return "requirement";
  return "general";
}

export function normalizeHost(value: string) {
  if (!value.trim()) return "";
  try {
    const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }
}

async function projectUsage(
  project: Awaited<ReturnType<typeof listRagProjects>>[number],
  appUrl: string | null | undefined,
  matchedBy: "selected_project" | "app_url" | "requirement",
  reason: string,
) {
  const documentRows = await db
    .select({ id: documents.id, sourceType: documents.sourceType })
    .from(documents)
    .where(eq(documents.ragProjectId, project.id));

  return {
    documentIds: documentRows.map((row) => row.id),
    usage: {
      mode: "used" as const,
      reason,
      projectId: project.id,
      projectName: project.name,
      sourceTypes: Array.from(new Set(documentRows.map((row) => row.sourceType))),
      appUrl: appUrl || null,
      matchedBy,
    },
  };
}

function skipped(appUrl: string | null | undefined, reason: string): { documentIds: string[]; usage: RagUsage } {
  return {
    documentIds: [],
    usage: {
      mode: "skipped",
      reason,
      projectId: null,
      projectName: null,
      sourceTypes: [],
      appUrl: appUrl || null,
      matchedBy: "none",
    },
  };
}

function projectMatchesHost(project: { domains: string[]; aliases: string[]; name: string }, host: string) {
  const candidates = [...(project.domains || []), ...(project.aliases || []), project.name].map(normalizeHost).filter(Boolean);
  return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`) || candidate.includes(host));
}

function tokenize(value: string) {
  return Array.from(new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []))
    .filter((term) => !["please", "give", "make", "create", "test", "case", "plan", "requirement"].includes(term))
    .slice(0, 40);
}

function extractDomains(value: string) {
  return Array.from(new Set(value.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []));
}

function metadataText(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return "";
  return JSON.stringify(metadata).slice(0, 1200);
}
