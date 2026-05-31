import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { documentChunks, documents } from "../db/schema.js";
import { embedText, rerankPairs } from "./local-models.js";
import { queryVectorIndex } from "./vector-service.js";

const stopWords = new Set([
  "please", "give", "create", "make", "based", "basis", "document", "attached",
  "requirement", "requirements", "test", "tests", "plan", "case", "cases", "related", "using",
  "with", "from", "for", "into", "that", "this", "what", "when", "where", "tell", "exact",
  "show", "list", "all", "and", "or", "the", "are", "was", "were", "has", "have", "me",
  "is", "does", "which", "who", "whom", "whose",
]);

const fieldAliases: Record<string, string[]> = {
  priority: ["priority", "priorities", "prirority", "prio", "p"],
  severity: ["severity", "impact", "criticality"],
  assignee: ["assignee", "assigned_to", "assigned", "owner", "qa_owner"],
  module: ["module", "feature", "area", "component"],
  status: ["status", "state"],
  tags: ["tags", "tag", "labels", "label"],
  release: ["release", "version", "milestone"],
  browser: ["browser", "browsers"],
  locale: ["locale", "language", "region"],
  method: ["method", "http_method"],
  path: ["path", "endpoint", "url", "route"],
};

const expansionMap: Record<string, string[]> = {
  login: ["signin", "sign", "authentication", "auth", "sso"],
  signin: ["login", "authentication", "auth"],
  requirement: ["acceptance", "criteria", "story"],
  functional: ["requirement", "requirements", "fr", "acceptance"],
  listing: ["catalog", "grid", "products"],
  environment: ["environments", "os", "browser", "platform"],
  environments: ["environment", "os", "browser", "platform"],
  api: ["endpoint", "request", "response", "method", "path"],
  testcase: ["scenario", "testcase", "test"],
  testcases: ["scenario", "testcase", "test"],
};

export type QueryFilter = {
  field: string;
  aliases: string[];
  value: string;
  sourceText: string;
  required: boolean;
};

export type QueryAnalysis = {
  intent: "answer" | "requirement_lookup" | "testcase_lookup" | "test_plan" | "test_case_generation" | "api_lookup" | "release_lookup";
  keywords: string[];
  expandedKeywords: string[];
  filters: QueryFilter[];
  filterMode: "all" | "any";
  documentSignals: string[];
  requestedOutput: "table" | "summary" | "plan" | "json" | "acceptance_criteria" | "test_cases" | "answer";
};

export type RetrievedChunk = {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  preview: string;
  fullText: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  structuredScore: number;
  rerankScore: number;
  matchedTerms: string[];
  matchedMetadataFields: string[];
  constraintMatchStatus: "exact" | "partial" | "none" | "not_required";
  retrievalReason: string;
  chunkKind: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown>;
};

export type RetrieveContextOptions = {
  topK?: number;
  debug?: boolean;
  intent?: "chat" | "requirement" | "test_plan" | "test_case";
};

type Row = {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  preview: string;
  fullText: string;
  vectorId: string;
  chunkKind: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export async function retrieveContext(scope: string, documentIds: string[], options: RetrieveContextOptions = {}) {
  const requestedTopK = options.topK || 6;
  const topK = /\b(all|every|list|show)\b/i.test(scope) ? Math.max(requestedTopK, 20) : requestedTopK;
  const rows = await db
    .select({
      id: documentChunks.id,
      documentId: documentChunks.documentId,
      documentName: documents.name,
      chunkIndex: documentChunks.chunkIndex,
      preview: documentChunks.chunkTextPreview,
      fullText: documentChunks.fullText,
      vectorId: documentChunks.vectorId,
      chunkKind: documentChunks.chunkKind,
      sourceLocator: documentChunks.sourceLocator,
      metadata: documentChunks.metadata,
      createdAt: documentChunks.createdAt,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(documentIds.length > 0 ? inArray(documentChunks.documentId, documentIds) : undefined)
    .orderBy(desc(documentChunks.createdAt));

  const analysis = analyzeQuery(scope, rows, options.intent);
  const queryVector = await embedText(scope);
  const vectorMatches = await queryVectorIndex(queryVector, Math.max(topK * 6, 30), documentIds);
  const vectorRank = new Map(vectorMatches.map((match, index) => [match.id, index + 1]));
  const vectorScore = new Map(vectorMatches.map((match) => [match.id, Number(match.score || 0)]));

  const scoredRows = rows.map((row) => scoreRow(row, analysis, vectorRank, vectorScore));
  const structuredRank = rankMap(scoredRows, "structuredScore");
  const lexicalRank = rankMap(scoredRows, "lexicalScore");
  const semanticRank = new Map(vectorMatches.map((match, index) => [match.id, index + 1]));

  const candidates = scoredRows
    .map((row) => ({
      ...row,
      rrfScore: reciprocalRankFusion(structuredRank.get(row.vectorId), lexicalRank.get(row.vectorId), semanticRank.get(row.vectorId)),
    }))
    .filter((row) => row.structuredScore > 0 || row.lexicalScore > 0 || row.semanticScore > 0)
    .sort((left, right) => right.rrfScore - left.rrfScore)
    .slice(0, Math.max(topK * 6, 30));

  const rerankScores = await rerankPairs(
    scope,
    candidates.map((row) => ({
      id: row.id,
      text: `${metadataSummary(row.metadata)}\n${row.fullText}`,
      lexicalScore: row.lexicalScore + row.structuredScore,
      semanticScore: row.semanticScore,
    })),
  );
  const rerankScoreById = new Map(rerankScores.map((item) => [item.id, item]));
  const reranked = candidates
    .map((row) => {
      const rerank = rerankScoreById.get(row.id);
      const rerankScore = rerank?.score ?? row.rrfScore;
      const testcaseBoost = analysis.intent === "testcase_lookup" && row.chunkKind === "testcase_row" ? 0.25 : 0;
      return toRetrievedChunk(row, rerankScore + testcaseBoost, rerank?.reason || "hybrid-structured-lexical-vector-rrf");
    })
    .sort(
      (left, right) =>
        right.rerankScore - left.rerankScore ||
        right.structuredScore + right.lexicalScore - (left.structuredScore + left.lexicalScore),
    );

  const validated = validateEvidence(reranked, analysis);
  const chunks = dedupeChunks(validated).slice(0, topK);

  return {
    query: scope,
    documentIds,
    chunks,
    status: "universal_precision_rag",
    retrieval: {
      method: "self_query_structured_bm25_vector_parent_child_rrf_rerank",
      topK,
      queryTerms: analysis.keywords,
      totalCandidateChunks: rows.length,
      candidateChunksAfterHybrid: candidates.length,
      returnedChunks: chunks.length,
      intent: options.intent || "chat",
      queryAnalysis: analysis,
      structuredConstraints: analysis.filters,
      structuredMatchCount: scoredRows.filter((row) => row.structuredScore > 0).length,
      note: "Uses self-query parsing, dynamic metadata matching, lexical scoring, vector search, RRF, reranking, and filter validation.",
    },
  };
}

function analyzeQuery(scope: string, rows: Row[], optionIntent?: RetrieveContextOptions["intent"]): QueryAnalysis {
  const normalized = scope.toLowerCase();
  const metadataKeys = collectMetadataKeys(rows);
  const filters = extractFilters(scope, metadataKeys);
  const filterMode = /\bor\b|\/|\|/i.test(scope) && filters.length > 1 ? "any" : "all";
  const keywords = tokenize(removeFilterText(scope, filters)).filter((term) => !filters.some((filter) => normalizeValue(filter.value) === normalizeValue(term)));
  const expandedKeywords = Array.from(new Set(keywords.flatMap((term) => [term, ...(expansionMap[term] || [])])));
  const documentSignals = detectDocumentSignals(normalized);
  const requestedOutput = detectRequestedOutput(normalized, optionIntent);

  return {
    intent: detectIntent(normalized, optionIntent),
    keywords,
    expandedKeywords,
    filters,
    filterMode,
    documentSignals,
    requestedOutput,
  };
}

function collectMetadataKeys(rows: Row[]) {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const field of getMetadataFields(row.metadata)) keys.add(field.normalizedKey);
    for (const key of Object.keys(row.metadata || {})) keys.add(normalizeKey(key));
  }

  for (const [canonical, aliases] of Object.entries(fieldAliases)) {
    const hasField = keys.has(canonical) || aliases.some((alias) => keys.has(alias));
    if (hasField) {
      keys.add(canonical);
      aliases.forEach((alias) => keys.add(alias));
    }
  }
  return keys;
}

function extractFilters(query: string, metadataKeys: Set<string>): QueryFilter[] {
  const filters: QueryFilter[] = [];
  const normalizedKeys = Array.from(metadataKeys).filter(Boolean).sort((a, b) => b.length - a.length);
  const queryWords = query.split(/\s+/).filter(Boolean);

  for (const field of normalizedKeys) {
      const aliases = aliasesFor(field);
    for (const alias of aliases) {
      const readable = alias.replace(/_/g, "[ _-]?");
      const patterns = [
        new RegExp(`\\b${readable}\\s*(?:[:=]|\\s+-\\s+)\\s*([a-zA-Z0-9_.@/-]+)`, "i"),
        new RegExp(`\\b${readable}\\s+to\\s+([a-zA-Z0-9_.@/-]+)`, "i"),
        new RegExp(`\\b${readable}\\s+([a-zA-Z0-9_.@/]+)`, "i"),
        new RegExp(`\\b([a-zA-Z0-9_.@/-]+)\\s+${readable}\\b`, "i"),
      ];
      for (const pattern of patterns) {
        const match = query.match(pattern);
        const value = cleanQueryToken(match?.[1]);
        const isReversePattern = pattern === patterns[3];
        if (
          value &&
          !isSeparatorToken(value) &&
          !stopWords.has(value.toLowerCase()) &&
          (!isReversePattern || allowsValueBeforeField(canonicalField(field)))
        ) {
          filters.push({
            field: canonicalField(field),
            aliases,
            value,
            sourceText: match?.[0] || value,
            required: true,
          });
        }
      }
    }
  }

  filters.push(...extractDynamicFieldFilters(queryWords, metadataKeys));

  for (let index = 0; index < queryWords.length - 1; index += 1) {
    const left = normalizeKey(queryWords[index]);
    const right = cleanQueryToken(nextMeaningfulWord(queryWords, index + 1));
    const field = resolveMetadataField(left, metadataKeys);
    if (field && right && !isSeparatorToken(right) && !stopWords.has(right.toLowerCase())) {
      filters.push({ field, aliases: aliasesFor(field), value: right, sourceText: `${queryWords[index]} ${right}`, required: true });
    }
  }

  return uniqueFilters(filters);
}

function extractDynamicFieldFilters(queryWords: string[], metadataKeys: Set<string>) {
  const filters: QueryFilter[] = [];
  const maxFieldWords = Math.min(4, queryWords.length - 1);

  for (let index = 0; index < queryWords.length; index += 1) {
    for (let length = maxFieldWords; length >= 1; length -= 1) {
      const fieldWords = queryWords.slice(index, index + length);
      const nextWord = nextMeaningfulWord(queryWords, index + length);
      if (!nextWord) continue;

      const fieldCandidate = normalizeKey(fieldWords.join(" "));
      const resolvedField = resolveMetadataField(fieldCandidate, metadataKeys);
      const value = cleanQueryToken(nextWord);
      if (resolvedField && value && !isSeparatorToken(value) && !stopWords.has(value.toLowerCase())) {
        filters.push({
          field: resolvedField,
          aliases: aliasesFor(resolvedField),
          value,
          sourceText: [...fieldWords, nextWord].join(" "),
          required: true,
        });
      }

      const previousWord = previousMeaningfulWord(queryWords, index - 1);
      const previousValue = cleanQueryToken(previousWord);
      if (
        resolvedField &&
        allowsValueBeforeField(resolvedField) &&
        previousValue &&
        !isSeparatorToken(previousValue) &&
        !stopWords.has(previousValue.toLowerCase())
      ) {
        filters.push({
          field: resolvedField,
          aliases: aliasesFor(resolvedField),
          value: previousValue,
          sourceText: [previousWord, ...fieldWords].join(" "),
          required: true,
        });
      }
    }
  }

  return filters;
}

function nextMeaningfulWord(words: string[], startIndex: number) {
  for (let index = startIndex; index < words.length; index += 1) {
    const cleaned = cleanQueryToken(words[index]);
    if (cleaned && !isSeparatorToken(cleaned)) return cleaned;
  }
  return undefined;
}

function previousMeaningfulWord(words: string[], startIndex: number) {
  for (let index = startIndex; index >= 0; index -= 1) {
    const cleaned = cleanQueryToken(words[index]);
    if (cleaned && !isSeparatorToken(cleaned)) return cleaned;
  }
  return undefined;
}

function scoreRow(row: Row, analysis: QueryAnalysis, vectorRank: Map<string, number>, vectorScore: Map<string, number>) {
  const searchable = searchableText(row);
  const matchedTerms = findMatchedTerms(searchable, analysis.expandedKeywords);
  const lexicalScore = scoreText(searchable, analysis.keywords, analysis.expandedKeywords, matchedTerms);
  const structured = scoreStructured(row, analysis.filters, analysis.filterMode);
  const signalScore = scoreSignals(row, analysis.documentSignals);
  const intentScore = scoreIntentFit(row, analysis);
  const semanticScore = vectorScore.get(row.vectorId) || 0;

  return {
    ...row,
    matchedTerms,
    matchedMetadataFields: structured.matchedFields,
    constraintMatchStatus: structured.status,
    lexicalScore: lexicalScore + signalScore + intentScore,
    structuredScore: structured.score,
    semanticScore,
    vectorRank: vectorRank.get(row.vectorId),
  };
}

function scoreIntentFit(row: Row, analysis: QueryAnalysis) {
  if (analysis.intent === "requirement_lookup") {
    const type = String(row.metadata?.documentType || "").toLowerCase();
    const name = row.documentName.toLowerCase();
    const sectionBoost = row.chunkKind === "requirement_section" ? 30 : 0;
    const sourceBoost = /prd|requirement|test_plan|test plan/.test(`${name} ${type}`) ? 12 : 0;
    const testcasePenalty = row.chunkKind === "testcase_row" ? -20 : 0;
    return sectionBoost + sourceBoost + testcasePenalty;
  }

  if (analysis.intent === "testcase_lookup") {
    return row.chunkKind === "testcase_row" ? 6 : -2;
  }

  if (analysis.intent === "api_lookup") {
    return row.chunkKind === "api_item" ? 6 : 0;
  }

  return 0;
}

function scoreStructured(row: Row, filters: QueryFilter[], filterMode: QueryAnalysis["filterMode"]) {
  if (filters.length === 0) {
    return { score: 0, matchedFields: [] as string[], status: "not_required" as const };
  }

  const fields = getMetadataFields(row.metadata);
  const matchedFields: string[] = [];
  let score = 0;

  for (const filter of filters) {
    const matched = fields.find((field) => {
      const keyMatches = filter.aliases.includes(field.normalizedKey) || canonicalField(field.normalizedKey) === filter.field;
      const valueMatches = fuzzyIncludes(field.value, filter.value);
      return keyMatches && valueMatches;
    });

    if (matched) {
      matchedFields.push(`${matched.normalizedKey}:${matched.value}`);
      score += normalizeValue(matched.value) === normalizeValue(filter.value) ? 8 : 5;
    }
  }

  const exactMatch = filterMode === "any" ? matchedFields.length > 0 : matchedFields.length === filters.length;

  return {
    score,
    matchedFields,
    status: exactMatch ? "exact" as const : matchedFields.length > 0 ? "partial" as const : "none" as const,
  };
}

function validateEvidence(chunks: RetrievedChunk[], analysis: QueryAnalysis) {
  if (analysis.filters.length === 0) {
    return preferIntentChunks(chunks.filter((chunk) => isRelevant(chunk, analysis) && matchesCoreTopic(chunk, analysis)), analysis);
  }

  const exact = preferIntentChunks(
    chunks.filter((chunk) => chunk.constraintMatchStatus === "exact" && matchesCoreTopic(chunk, analysis)),
    analysis,
  );
  if (exact.length > 0) return exact;

  const partial = preferIntentChunks(
    chunks.filter((chunk) => chunk.constraintMatchStatus === "partial" && matchesCoreTopic(chunk, analysis)),
    analysis,
  );
  if (partial.length > 0) return partial;

  return [];
}

function preferIntentChunks(chunks: RetrievedChunk[], analysis: QueryAnalysis) {
  if (analysis.intent === "testcase_lookup") {
    const testcases = chunks.filter((chunk) => chunk.chunkKind === "testcase_row");
    if (testcases.length > 0) return testcases;
  }

  if (analysis.intent === "requirement_lookup") {
    const requirements = chunks.filter((chunk) => chunk.chunkKind === "requirement_section");
    if (requirements.length > 0) return requirements;
  }

  if (analysis.intent === "api_lookup") {
    const apiItems = chunks.filter((chunk) => chunk.chunkKind === "api_item");
    if (apiItems.length > 0) return apiItems;
  }

  return chunks;
}

function toRetrievedChunk(row: ReturnType<typeof scoreRow> & { rrfScore: number }, rerankScore: number, reason: string): RetrievedChunk {
  return {
    id: row.id,
    documentId: row.documentId,
    documentName: row.documentName,
    chunkIndex: row.chunkIndex,
    preview: row.preview,
    fullText: row.fullText,
    score: rerankScore,
    lexicalScore: row.lexicalScore,
    semanticScore: row.semanticScore,
    structuredScore: row.structuredScore,
    rerankScore,
    matchedTerms: row.matchedTerms,
    matchedMetadataFields: row.matchedMetadataFields,
    constraintMatchStatus: row.constraintMatchStatus,
    retrievalReason: reason,
    chunkKind: row.chunkKind,
    sourceLocator: row.sourceLocator,
    metadata: row.metadata || {},
  };
}

function searchableText(row: Row) {
  const metadata = row.metadata || {};
  return [
    row.documentName,
    row.chunkKind,
    row.sourceLocator || "",
    typeof metadata.searchableText === "string" ? metadata.searchableText : "",
    metadataSummary(metadata),
    row.fullText,
  ].join("\n").toLowerCase();
}

function metadataSummary(metadata: Record<string, unknown>) {
  return getMetadataFields(metadata).map((field) => `${field.normalizedKey}: ${field.value}`).join("\n");
}

function getMetadataFields(metadata: Record<string, unknown>) {
  const fields: Array<{ originalKey: string; normalizedKey: string; value: string }> = [];
  const rawFields = Array.isArray(metadata?.metadataFields) ? metadata.metadataFields : [];
  for (const field of rawFields) {
    if (field && typeof field === "object") {
      const row = field as Record<string, unknown>;
      if (row.normalizedKey && row.value !== undefined) {
        fields.push({
          originalKey: String(row.originalKey || row.normalizedKey),
          normalizedKey: normalizeKey(String(row.normalizedKey)),
          value: String(row.value),
        });
      }
    }
  }
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === null || value === undefined || typeof value === "object") continue;
    const normalizedKey = normalizeKey(key);
    if (!fields.some((field) => field.normalizedKey === normalizedKey)) {
      fields.push({ originalKey: key, normalizedKey, value: String(value) });
    }
  }
  return fields;
}

function tokenize(text: string) {
  return Array.from(new Set(text.toLowerCase().split(/[^a-z0-9_.@/-]+/).filter((term) => term.length > 1 && !stopWords.has(term))));
}

function findMatchedTerms(text: string, terms: string[]) {
  return terms.filter((term) => fuzzyIncludes(text, term));
}

function scoreText(text: string, keywords: string[], expanded: string[], matchedTerms: string[]) {
  const exactScore = keywords.reduce((score, term) => score + countOccurrences(text, term) * 2.5, 0);
  const expandedScore = expanded.filter((term) => !keywords.includes(term)).reduce((score, term) => score + countOccurrences(text, term) * 0.6, 0);
  return exactScore + expandedScore + matchedTerms.length * 1.5;
}

function scoreSignals(row: Row, signals: string[]) {
  if (signals.length === 0) return 0;
  const haystack = `${row.chunkKind} ${row.metadata?.documentType || ""} ${row.metadata?.headingPath || ""}`.toLowerCase();
  return signals.reduce((score, signal) => score + (haystack.includes(signal) ? 1.5 : 0), 0);
}

function isRelevant(row: RetrievedChunk, analysis: QueryAnalysis) {
  if (analysis.keywords.length === 0 && analysis.filters.length === 0) {
    return row.semanticScore >= 0.35 || row.rerankScore >= 0.2;
  }
  return row.matchedTerms.length > 0 || row.structuredScore > 0 || row.semanticScore >= 0.45 || row.rerankScore >= 0.35;
}

function matchesCoreTopic(row: RetrievedChunk, analysis: QueryAnalysis) {
  const coreTerms = analysis.keywords.filter((term) => !isGenericRetrievalTerm(term));
  if (coreTerms.length === 0) return true;
  const searchable = searchableChunkText(row);
  const expandedCoreTerms = Array.from(new Set(coreTerms.flatMap((term) => [term, ...(expansionMap[term] || [])])));
  return expandedCoreTerms.some((term) => fuzzyIncludes(searchable, term));
}

function searchableChunkText(row: Pick<RetrievedChunk, "documentName" | "chunkKind" | "sourceLocator" | "metadata" | "fullText">) {
  const metadata = row.metadata || {};
  return [
    row.documentName,
    row.chunkKind,
    row.sourceLocator || "",
    typeof metadata.searchableText === "string" ? metadata.searchableText : "",
    metadataSummary(metadata),
    row.fullText,
  ].join("\n").toLowerCase();
}

function isGenericRetrievalTerm(term: string) {
  return /^(testcase|testcases|scenario|scenarios|table|data|detail|details)$/.test(term);
}

function dedupeChunks(chunks: RetrievedChunk[]) {
  const seen = new Set<string>();
  const results: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.documentId}:${chunk.fullText.replace(/\s+/g, " ").slice(0, 180).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(chunk);
  }
  return results;
}

function rankMap<T extends { vectorId: string }>(rows: Array<T & Record<string, unknown>>, key: string) {
  return new Map(
    rows
      .filter((row) => Number(row[key]) > 0)
      .sort((left, right) => Number(right[key]) - Number(left[key]))
      .map((row, index): [string, number] => [row.vectorId, index + 1]),
  );
}

function reciprocalRankFusion(...ranks: Array<number | undefined>): number {
  const k = 60;
  return ranks.reduce((score: number, rank) => score + (rank ? 1 / (k + rank) : 0), 0);
}

function countOccurrences(text: string, term: string) {
  const normalizedTerm = normalizeValue(term);
  if (!normalizedTerm) return 0;
  let count = 0;
  let index = text.indexOf(normalizedTerm);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(normalizedTerm, index + normalizedTerm.length);
  }
  return count;
}

function fuzzyIncludes(value: string, expected: string) {
  const left = normalizeValue(value);
  const right = normalizeValue(expected);
  return left === right || left.includes(right) || right.includes(left);
}

function normalizeValue(value: string) {
  return String(value).toLowerCase().replace(/[^a-z0-9.@/-]+/g, " ").trim();
}

function normalizeKey(value: string) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function cleanQueryToken(value: string | undefined) {
  return value?.replace(/^[^\w.@/-]+|[^\w.@/-]+$/g, "") || "";
}

function isSeparatorToken(value: string) {
  return /^[-:=]+$/.test(value.trim());
}

function resolveMetadataField(candidate: string, metadataKeys: Set<string>) {
  const normalized = normalizeKey(candidate);
  if (!normalized || stopWords.has(normalized)) return null;
  if (metadataKeys.has(normalized)) return canonicalField(normalized);

  const canonical = canonicalField(normalized);
  if (metadataKeys.has(canonical)) return canonical;

  let best: { key: string; score: number } | null = null;
  for (const key of metadataKeys) {
    const score = keySimilarity(normalized, key);
    if (!best || score > best.score) {
      best = { key, score };
    }
  }

  if (best && best.score >= 0.82) {
    return canonicalField(best.key);
  }

  return null;
}

function keySimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);

  const distance = levenshtein(left, right);
  const maxLength = Math.max(left.length, right.length);
  return maxLength === 0 ? 0 : 1 - distance / maxLength;
}

function levenshtein(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);

  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let previous = rows[0];
    rows[0] = rightIndex;

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = rows[leftIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      rows[leftIndex] = Math.min(
        rows[leftIndex] + 1,
        rows[leftIndex - 1] + 1,
        previous + cost,
      );
      previous = current;
    }
  }

  return rows[left.length];
}

function canonicalField(field: string) {
  const normalized = normalizeKey(field);
  for (const [canonical, aliases] of Object.entries(fieldAliases)) {
    if (canonical === normalized || aliases.includes(normalized)) return canonical;
  }
  return normalized;
}

function aliasesFor(field: string) {
  const canonical = canonicalField(field);
  return Array.from(new Set([canonical, field, ...(fieldAliases[canonical] || [])].map(normalizeKey)));
}

function allowsValueBeforeField(field: string) {
  return new Set(["priority", "severity", "status", "release", "browser", "locale", "method"]).has(canonicalField(field));
}

function uniqueFilters(filters: QueryFilter[]) {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = `${filter.field}:${normalizeValue(filter.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeFilterText(scope: string, filters: QueryFilter[]) {
  return filters.reduce((text, filter) => text.replace(filter.sourceText, " "), scope);
}

function detectIntent(normalized: string, optionIntent?: RetrieveContextOptions["intent"]): QueryAnalysis["intent"] {
  if (optionIntent === "test_plan") return "test_plan";
  if (optionIntent === "test_case") return "test_case_generation";
  if (/api|endpoint|request|response|method|path/.test(normalized)) return "api_lookup";
  if (/test\s*case|testcase|scenario/.test(normalized)) return "testcase_lookup";
  if (/requirement|acceptance|criteria|user story|prd/.test(normalized)) return "requirement_lookup";
  if (/release|change|changelog/.test(normalized)) return "release_lookup";
  return "answer";
}

function detectRequestedOutput(normalized: string, optionIntent?: RetrieveContextOptions["intent"]): QueryAnalysis["requestedOutput"] {
  if (optionIntent === "test_plan") return "plan";
  if (optionIntent === "test_case") return "json";
  if (/table|test\s*case|testcase/.test(normalized)) return "table";
  if (/acceptance/.test(normalized)) return "acceptance_criteria";
  if (/summary|summarize/.test(normalized)) return "summary";
  return "answer";
}

function detectDocumentSignals(normalized: string) {
  const signals: string[] = [];
  if (/requirement|prd|acceptance|criteria|story/.test(normalized)) signals.push("requirement");
  if (/api|endpoint|request|response|method|path/.test(normalized)) signals.push("api");
  if (/test\s*case|testcase|scenario/.test(normalized)) signals.push("testcase");
  if (/release|change|changelog/.test(normalized)) signals.push("release");
  if (/bug|defect|issue/.test(normalized)) signals.push("bug");
  if (/design|ux|ui/.test(normalized)) signals.push("design");
  return signals;
}
