export const embeddingModelName = "Xenova/all-MiniLM-L6-v2";
export const rerankerModelName = "Xenova/ms-marco-MiniLM-L-6-v2";

type FeaturePipeline = (input: string, options?: Record<string, unknown>) => Promise<unknown>;
type RerankPipeline = (input: string | string[], options?: Record<string, unknown>) => Promise<unknown>;

let embeddingPipelinePromise: Promise<FeaturePipeline> | null = null;
let rerankerPipelinePromise: Promise<RerankPipeline> | null = null;

export async function embedText(text: string): Promise<number[]> {
  try {
    const pipe = await getEmbeddingPipeline();
    const output = await pipe(text.slice(0, 4000), {
      pooling: "mean",
      normalize: true,
    });
    return extractVector(output);
  } catch {
    return deterministicEmbedding(text);
  }
}

export async function rerankPairs(
  query: string,
  candidates: Array<{ id: string; text: string; lexicalScore: number; semanticScore: number }>,
) {
  const fallback = candidates.map((candidate) => ({
    id: candidate.id,
    score: candidate.lexicalScore * 0.6 + candidate.semanticScore * 0.4,
    reason: "weighted-fallback",
  }));

  try {
    const pipe = await getRerankerPipeline();
    const scored = await Promise.all(
      candidates.map(async (candidate) => {
        const output = await pipe(`${query} [SEP] ${candidate.text.slice(0, 1200)}`);
        return {
          id: candidate.id,
          score: extractScore(output, candidate.lexicalScore * 0.6 + candidate.semanticScore * 0.4),
          reason: "local-cross-encoder",
        };
      }),
    );

    return scored;
  } catch {
    return fallback;
  }
}

async function getEmbeddingPipeline(): Promise<FeaturePipeline> {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = import("@xenova/transformers").then(async ({ pipeline }) => {
      return pipeline("feature-extraction", embeddingModelName) as Promise<FeaturePipeline>;
    });
  }

  return embeddingPipelinePromise;
}

async function getRerankerPipeline(): Promise<RerankPipeline> {
  if (!rerankerPipelinePromise) {
    rerankerPipelinePromise = import("@xenova/transformers").then(async ({ pipeline }) => {
      return pipeline("text-classification", rerankerModelName) as Promise<RerankPipeline>;
    });
  }

  return rerankerPipelinePromise;
}

function extractVector(output: unknown) {
  const value = output as { data?: Iterable<number>; dims?: number[] } | number[] | number[][];

  if (Array.isArray(value)) {
    return Array.isArray(value[0]) ? (value[0] as number[]) : (value as number[]);
  }

  if (value?.data) {
    return Array.from(value.data);
  }

  return deterministicEmbedding(JSON.stringify(output));
}

function extractScore(output: unknown, fallback: number) {
  if (Array.isArray(output)) {
    const first = output[0] as { score?: number } | undefined;
    return typeof first?.score === "number" ? first.score : fallback;
  }

  const maybe = output as { score?: number };
  return typeof maybe?.score === "number" ? maybe.score : fallback;
}

function deterministicEmbedding(text: string) {
  const vector = new Array(384).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  for (const token of tokens) {
    const hash = hashToken(token);
    vector[Math.abs(hash) % vector.length] += hash > 0 ? 1 : -1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function hashToken(token: string) {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash << 5) - hash + token.charCodeAt(index);
    hash |= 0;
  }

  return hash;
}
