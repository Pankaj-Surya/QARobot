import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { documentChunks, documents } from "../db/schema.js";
import { deleteDocumentObject, downloadDocumentObject } from "../lib/document-storage.js";
import { chunkDocument, extractTextFromDocument } from "./document-processing.js";
import { embeddingModelName } from "./local-models.js";
import { deleteVectors, embedAndIndexChunks } from "./vector-service.js";

type DocumentRow = typeof documents.$inferSelect;

export async function ingestDocument(documentId: string) {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

  if (!document) {
    throw new Error("Document not found");
  }

  return ingestDocumentRow(document);
}

export async function rebuildDocumentIngestion() {
  const existingVectors = await db.select({ vectorId: documentChunks.vectorId }).from(documentChunks);
  await deleteVectors(existingVectors.map((chunk) => chunk.vectorId));
  await db.delete(documentChunks);

  const existingDocuments = await db.select().from(documents);
  await db.update(documents).set({ status: "processing", errorMessage: null, chunkCount: 0 });

  const results = [];
  for (const document of existingDocuments) {
    try {
      results.push(await ingestDocumentRow({ ...document, status: "processing", errorMessage: null, chunkCount: 0 }));
    } catch (error) {
      results.push({
        documentId: document.id,
        documentName: document.name,
        status: "failed",
        error: error instanceof Error ? error.message : "Document ingestion failed",
        chunksIndexed: 0,
      });
    }
  }

  return {
    documentsProcessed: results.length,
    chunksIndexed: results.reduce((total, result) => total + result.chunksIndexed, 0),
    results,
  };
}

export async function deleteDocumentSource(documentId: string) {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

  if (!document) {
    throw new Error("Document not found");
  }

  const result = await deleteDocumentRows([document]);
  return {
    documentsDeleted: 1,
    chunksDeleted: result.chunksDeleted,
    vectorIdsDeleted: result.vectorIdsDeleted,
    warnings: result.warnings,
  };
}

export async function deleteAllDocumentSources() {
  const allDocuments = await db.select().from(documents);
  const result = await deleteDocumentRows(allDocuments);
  return {
    documentsDeleted: allDocuments.length,
    chunksDeleted: result.chunksDeleted,
    vectorIdsDeleted: result.vectorIdsDeleted,
    warnings: result.warnings,
  };
}

async function deleteDocumentRows(targetDocuments: DocumentRow[]) {
  const warnings: string[] = [];
  const documentIds = targetDocuments.map((document) => document.id);

  if (documentIds.length === 0) {
    return { chunksDeleted: 0, vectorIdsDeleted: 0, warnings };
  }

  const chunkRows = await db.select({ vectorId: documentChunks.vectorId }).from(documentChunks);
  const targetVectorIds =
    targetDocuments.length === (await db.select().from(documents)).length
      ? chunkRows.map((chunk) => chunk.vectorId)
      : (
          await Promise.all(
            documentIds.map((documentId) =>
              db
                .select({ vectorId: documentChunks.vectorId })
                .from(documentChunks)
                .where(eq(documentChunks.documentId, documentId)),
            ),
          )
        ).flat().map((chunk) => chunk.vectorId);

  try {
    await deleteVectors(targetVectorIds);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Vector cleanup failed.");
  }

  for (const document of targetDocuments) {
    try {
      await deleteDocumentObject(document.r2Key);
    } catch (error) {
      warnings.push(
        `File cleanup failed for ${document.name}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  let chunksDeleted = 0;
  for (const documentId of documentIds) {
    const deletedChunks = await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId)).returning();
    chunksDeleted += deletedChunks.length;
    await db.delete(documents).where(eq(documents.id, documentId));
  }

  return {
    chunksDeleted,
    vectorIdsDeleted: targetVectorIds.length,
    warnings,
  };
}

async function ingestDocumentRow(document: DocumentRow) {
  try {
    await db
      .update(documents)
      .set({ status: "processing", errorMessage: null })
      .where(eq(documents.id, document.id));

    const buffer = await downloadDocumentObject(document.r2Key);
    const text = await extractTextFromDocument(buffer, document.fileType, document.name);
    const chunks = chunkDocument(text, document.fileType, document.name);

    const oldVectors = await db
      .select({ vectorId: documentChunks.vectorId })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, document.id));

    await deleteVectors(oldVectors.map((chunk) => chunk.vectorId));
    await db.delete(documentChunks).where(and(eq(documentChunks.documentId, document.id)));

    if (chunks.length > 0) {
      const vectorInputs = chunks.map((chunk) => ({
        vectorId: `${document.id}:${chunk.chunkIndex}`,
        text: chunk.fullText,
        metadata: {
          documentId: document.id,
          documentName: document.name,
          chunkIndex: chunk.chunkIndex,
          chunkKind: chunk.chunkKind,
          sourceLocator: chunk.sourceLocator,
          ...chunk.metadata,
        },
      }));
      await embedAndIndexChunks(vectorInputs);

      await db.insert(documentChunks).values(
        chunks.map((chunk) => ({
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          chunkTextPreview: chunk.preview,
          fullText: chunk.fullText,
          vectorId: `${document.id}:${chunk.chunkIndex}`,
          chunkKind: chunk.chunkKind,
          sourceLocator: chunk.sourceLocator,
          metadata: chunk.metadata,
          tokenCount: chunk.tokenCount,
          embeddingModel: embeddingModelName,
        })),
      );
    }

    const [updated] = await db
      .update(documents)
      .set({
        status: "indexed",
        errorMessage: null,
        chunkCount: chunks.length,
      })
      .where(eq(documents.id, document.id))
      .returning();

    return {
      documentId: updated.id,
      documentName: updated.name,
      status: updated.status,
      chunksIndexed: chunks.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Document ingestion failed";
    await db
      .update(documents)
      .set({
        status: "failed",
        errorMessage: message,
      })
      .where(eq(documents.id, document.id));

    throw new Error(message);
  }
}
