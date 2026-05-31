import { createVectorIndex } from "../lib/upstash.js";
import { embedText, embeddingModelName } from "./local-models.js";

export async function embedAndIndexChunks(
  chunks: Array<{
    vectorId: string;
    text: string;
    metadata: Record<string, unknown>;
  }>,
) {
  const embedded = await Promise.all(
    chunks.map(async (chunk) => ({
      ...chunk,
      vector: await embedText(chunk.text),
    })),
  );

  try {
    const index = createVectorIndex() as unknown as {
      upsert: (items: Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }>) => Promise<unknown>;
    };

    await index.upsert(
      embedded.map((chunk) => ({
        id: chunk.vectorId,
        vector: chunk.vector,
        metadata: {
          ...chunk.metadata,
          embeddingModel: embeddingModelName,
        },
      })),
    );
  } catch {
    // Local DB chunks remain usable through lexical retrieval if vector indexing is unavailable.
  }

  return embedded;
}

export async function queryVectorIndex(vector: number[], topK: number, documentIds: string[]) {
  try {
    const index = createVectorIndex() as unknown as {
      query: (options: {
        vector: number[];
        topK: number;
        includeMetadata: boolean;
        filter?: string;
      }) => Promise<Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>>;
    };

    const filter =
      documentIds.length > 0
        ? documentIds.map((id) => `documentId = '${id}'`).join(" OR ")
        : undefined;

    return await index.query({
      vector,
      topK,
      includeMetadata: true,
      filter,
    });
  } catch {
    return [];
  }
}

export async function deleteVectors(vectorIds: string[]) {
  if (vectorIds.length === 0) {
    return;
  }

  try {
    const index = createVectorIndex() as unknown as {
      delete: (ids: string[]) => Promise<unknown>;
    };

    await index.delete(vectorIds);
  } catch {
    // Rebuild can continue with Postgres chunks even when vector cleanup is unavailable.
  }
}
