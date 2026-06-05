import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/client.js";
import { documentChunks, documents, ragProjects } from "../db/schema.js";
import { uploadDocumentObject } from "../lib/document-storage.js";
import { isSupportedDocument } from "../services/document-processing.js";
import { retrieveContext, type RetrievedChunk } from "../services/rag-service.js";
import { generateWithFeatureModel } from "../services/ai-adapter.js";
import { inferDocumentMapping, sourceTypes } from "../services/rag-projects.js";
import {
  deleteAllDocumentSources,
  deleteDocumentSource,
  ingestDocument,
  rebuildDocumentIngestion,
} from "../services/document-ingestion.js";

const askDocumentsSchema = z.object({
  question: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional().default(12),
  debug: z.boolean().optional().default(false),
});

export async function documentsRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await db
      .select({
        id: documents.id,
        name: documents.name,
        fileType: documents.fileType,
        fileSize: documents.fileSize,
        ragProjectId: documents.ragProjectId,
        sourceType: documents.sourceType,
        ragProjectName: ragProjects.name,
        status: documents.status,
        errorMessage: documents.errorMessage,
        chunkCount: documents.chunkCount,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .leftJoin(ragProjects, eq(ragProjects.id, documents.ragProjectId))
      .orderBy(desc(documents.createdAt));

    return { documents: rows };
  });

  app.post("/ask", async (request, reply) => {
    const parsed = askDocumentsSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid document question",
        details: parsed.error.flatten(),
      });
    }

    const { question, topK, debug } = parsed.data;
    const context = await retrieveContext(question, [], { topK, debug, intent: "chat" });

    if (context.chunks.length === 0) {
      return {
        question,
        answer: "No related data is available in the ingested knowledge base for this question.",
        retrieval: debug ? context.retrieval : undefined,
        chunks: [],
      };
    }

    if (isTestCaseQuestion(question)) {
      return {
        question,
        answer: buildRagAnswer(question, context.chunks),
        retrieval: debug ? context.retrieval : undefined,
        chunks: debug ? context.chunks.map(debugChunk) : [],
      };
    }

    try {
      const answer = await generateWithFeatureModel(
        "document_chat",
        [
          {
            role: "system",
            content:
              "You are a senior QA analyst. Answer only from the provided evidence. Do not expose retrieval metadata. For PRD and test plan questions, cite the relevant section heading or source locator in natural language. If evidence is insufficient, say no related data is available.",
          },
          {
            role: "user",
            content: `Question:\n${question}\n\nEvidence:\n${formatEvidence(context.chunks)}`,
          },
        ],
      );

      return {
        question,
        answer,
        retrieval: debug ? context.retrieval : undefined,
        chunks: debug ? context.chunks.map(debugChunk) : [],
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "LLM generation failed",
      });
    }
  });

  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [document] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);

    if (!document) {
      return reply.code(404).send({ error: "Document not found" });
    }

    const chunks = await db
      .select({
        id: documentChunks.id,
        chunkIndex: documentChunks.chunkIndex,
        chunkTextPreview: documentChunks.chunkTextPreview,
        fullText: documentChunks.fullText,
        vectorId: documentChunks.vectorId,
      })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, id))
      .orderBy(documentChunks.chunkIndex);

    return { document, chunks };
  });

  app.post("/upload", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ error: "Multipart upload must include a file field." });
    }

    if (!isSupportedDocument(file.mimetype, file.filename)) {
      return reply.code(415).send({
        error: "Unsupported file type. Upload PDF, TXT, CSV, Markdown, JSON, YAML, or Gherkin files.",
      });
    }

    const fieldValue = (name: string) => {
      const field = file.fields[name] as { value?: unknown } | undefined;
      return typeof field?.value === "string" ? field.value : "";
    };
    const requestedProjectId = fieldValue("ragProjectId") || null;
    const requestedSourceType = sourceTypes.includes(fieldValue("sourceType") as (typeof sourceTypes)[number])
      ? fieldValue("sourceType")
      : undefined;
    const buffer = await file.toBuffer();
    const textForMapping = buffer.toString("utf8").slice(0, 8000);
    const mapping = await inferDocumentMapping({
      fileName: file.filename,
      text: textForMapping,
      sourceType: requestedSourceType as (typeof sourceTypes)[number] | undefined,
    });
    const finalProjectId = requestedProjectId || mapping.ragProjectId;

    if (!finalProjectId) {
      return reply.code(400).send({
        error: "Select or create a RAG Project before uploading. Documents cannot be unassigned because retrieval is grouped by project.",
      });
    }
    const r2Key = `documents/${new Date().toISOString().slice(0, 10)}/${nanoid()}-${safeFileName(
      file.filename,
    )}`;

    await uploadDocumentObject({
      key: r2Key,
      body: buffer,
      contentType: file.mimetype || "application/octet-stream",
    });

    const [document] = await db
      .insert(documents)
      .values({
        name: file.filename,
        fileType: file.mimetype || "application/octet-stream",
        fileSize: buffer.byteLength,
        r2Key,
        ragProjectId: finalProjectId,
        sourceType: mapping.sourceType,
        status: "processing",
      })
      .returning();

    return reply.code(201).send({
      document,
      next: {
        processEndpoint: "/api/documents/process",
        payload: { documentId: document.id },
      },
    });
  });

  app.post("/ingestion/rebuild", async () => {
    return rebuildDocumentIngestion();
  });

  app.put("/:id/rag-mapping", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        ragProjectId: z.string().uuid(),
        sourceType: z.enum(sourceTypes).optional().default("general"),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid document RAG mapping", details: parsed.error.flatten() });
    }

    const [project] = await db.select().from(ragProjects).where(eq(ragProjects.id, parsed.data.ragProjectId)).limit(1);
    if (!project) return reply.code(404).send({ error: "RAG Project not found" });

    const [document] = await db
      .update(documents)
      .set({ ragProjectId: parsed.data.ragProjectId, sourceType: parsed.data.sourceType })
      .where(eq(documents.id, id))
      .returning();

    if (!document) return reply.code(404).send({ error: "Document not found" });
    return { document };
  });

  app.delete("/", async () => {
    const result = await deleteAllDocumentSources();
    return { ok: true, ...result };
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = await deleteDocumentSource(id);
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Document deletion failed";
      const status = message === "Document not found" ? 404 : 500;
      return reply.code(status).send({ error: message });
    }
  });

  app.post("/process", async (request, reply) => {
    const { documentId } = request.body as { documentId?: string };

    if (!documentId) {
      return reply.code(400).send({ error: "documentId is required" });
    }

    const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

    if (!document) {
      return reply.code(404).send({ error: "Document not found" });
    }

    try {
      const result = await ingestDocument(document.id);
      const [updated] = await db.select().from(documents).where(eq(documents.id, document.id)).limit(1);
      return { document: updated, chunksIndexed: result.chunksIndexed };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Document processing failed";
      const [updated] = await db.select().from(documents).where(eq(documents.id, document.id)).limit(1);
      return reply.code(500).send({ error: message, document: updated });
    }
  });
}

function safeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function formatEvidence(chunks: RetrievedChunk[]) {
  return chunks
    .map(
      (chunk, index) =>
        `[E${index + 1}] ${chunk.documentName} ${chunk.sourceLocator || `chunk ${chunk.chunkIndex + 1}`}\n${formatChunkMetadata(chunk)}\n${chunk.fullText}`,
    )
    .join("\n\n---\n\n");
}

function formatChunkMetadata(chunk: RetrievedChunk) {
  const fields = getMetadataFields(chunk.metadata);
  if (fields.length === 0) return "";
  return fields.map((field) => `${field.originalKey}: ${field.value}`).join("\n");
}

function debugChunk(chunk: RetrievedChunk) {
  return {
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    chunkIndex: chunk.chunkIndex,
    sourceLocator: chunk.sourceLocator,
    chunkKind: chunk.chunkKind,
    score: chunk.score,
    lexicalScore: chunk.lexicalScore,
    structuredScore: chunk.structuredScore,
    semanticScore: chunk.semanticScore,
    rerankScore: chunk.rerankScore,
    matchedTerms: chunk.matchedTerms,
    matchedMetadataFields: chunk.matchedMetadataFields,
    constraintMatchStatus: chunk.constraintMatchStatus,
    retrievalReason: chunk.retrievalReason,
    preview: chunk.preview,
    metadata: chunk.metadata,
  };
}

function isTestCaseQuestion(question: string) {
  return /test\s*case|testcase|scenario|qa case/i.test(question);
}

function buildRagAnswer(question: string, chunks: RetrievedChunk[]) {
  if (chunks.length === 0) {
    return [
      "No related data is available in the ingested knowledge base for this question.",
      "",
      "Try selecting a different document, asking with more specific product terms, or uploading the relevant requirement file.",
    ].join("\n");
  }

  const lowerQuestion = question.toLowerCase();
  const isTestCaseRequest = /test\s*case|testcase|scenario|qa case/.test(lowerQuestion);
  const isRequirementRequest = /requirement|implement|spec|acceptance/.test(lowerQuestion);

  if (isTestCaseRequest) {
    const displayLimit = /\b(all|every|list|show)\b/i.test(question) ? 20 : 12;
    const visibleChunks = chunks.slice(0, displayLimit);
    const rows = visibleChunks
      .map((chunk, index) => formatTestCaseRow(chunk, index + 1))
      .join("\n");
    const limitNote = chunks.length > visibleChunks.length ? `\n\nShowing ${visibleChunks.length} of ${chunks.length} retrieved matching rows.` : "";

    return `## Suggested Test Cases

| ID | Title | Module | Priority | Type | Preconditions | Steps | Test Data | Expected Result | Status | Labels |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

## Summary
These test cases are based only on matching retrieved RAG evidence. Review them before saving or exporting.${limitNote}`;
  }

  if (isRequirementRequest) {
    return `## Requirement Answer

${chunks
  .slice(0, 5)
  .map((chunk, index) => `${index + 1}. ${cleanExcerpt(relevantExcerpt(chunk))}`)
  .join("\n")}

## Implementation Guidance
- Convert each listed behavior into acceptance criteria.
- Add validation for negative cases, security behavior, and error states mentioned above.
- Use the same source evidence when creating test cases.`;
  }

  return `## Answer

${chunks
  .slice(0, 5)
  .map((chunk, index) => `${index + 1}. ${cleanExcerpt(relevantExcerpt(chunk))}`)
  .join("\n")}`;
}

function cleanExcerpt(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 420);
}

function summarizeIntent(text: string) {
  const cleaned = cleanExcerpt(text);
  const sentence = cleaned.split(/[.!?]/)[0] || cleaned;
  return sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence;
}

function relevantExcerpt(chunk: RetrievedChunk) {
  const lines = chunk.fullText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const term of chunk.matchedTerms) {
    const line = lines.find((candidate) => candidate.toLowerCase().includes(term));
    if (line) {
      return line;
    }
  }

  return chunk.fullText;
}

function formatTestCaseRow(chunk: RetrievedChunk, index: number) {
  const fields = getMetadataFields(chunk.metadata);
  const fieldValue = (...names: string[]) => pickMetadataValue(fields, names);
  const fallbackTitle = summarizeIntent(chunk.fullText);

  const id = fieldValue("test case id", "id", "key") || `TC-${String(index).padStart(3, "0")}`;
  const title = fieldValue("summary", "title", "name", "test case") || fallbackTitle;
  const module = fieldValue("component", "module", "area", "feature", "test scenario", "scenario") || "General";
  const priority = fieldValue("priority", "prio", "p") || "-";
  const type = fieldValue("issue type", "type", "test type") || "Functional";
  const preconditions = fieldValue("preconditions", "precondition") || "-";
  const steps = fieldValue("test steps", "steps", "step") || "Review source requirement and execute matching workflow";
  const testData = fieldValue("test data", "data") || "-";
  const expected = fieldValue("expected result", "expected", "expected outcome") || "Behavior matches requirement";
  const status = fieldValue("result", "status", "state") || "-";
  const labels = fieldValue("labels", "tags", "tag") || "-";

  return `| ${tableCell(id)} | ${tableCell(title)} | ${tableCell(
    module,
  )} | ${tableCell(priority)} | ${tableCell(type)} | ${tableCell(preconditions)} | ${tableCell(
    steps,
  )} | ${tableCell(testData)} | ${tableCell(
    expected,
  )} | ${tableCell(status)} | ${tableCell(labels)} |`;
}

function tableCell(value: string) {
  return cleanExcerpt(value || "-").replace(/\|/g, "/").replace(/\n/g, " ");
}

function getMetadataFields(metadata: Record<string, unknown>) {
  const rawFields = Array.isArray(metadata?.metadataFields) ? metadata.metadataFields : [];
  return rawFields
    .filter((field): field is { originalKey: string; normalizedKey: string; value: string } =>
      Boolean(field && typeof field === "object" && "normalizedKey" in field && "value" in field),
    )
    .map((field) => ({
      originalKey: String(field.originalKey || field.normalizedKey),
      normalizedKey: normalizeKey(String(field.normalizedKey)),
      value: String(field.value),
    }));
}

function pickMetadataValue(
  fields: Array<{ originalKey: string; normalizedKey: string; value: string }>,
  names: string[],
) {
  const keys = names.map(normalizeKey);
  return fields.find((field) => keys.includes(field.normalizedKey))?.value || "";
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
