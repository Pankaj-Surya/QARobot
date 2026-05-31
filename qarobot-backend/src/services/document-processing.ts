import pdfParse from "pdf-parse";
import { parse as parseCsv } from "csv-parse/sync";

const TEXT_FILE_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/csv",
  "application/x-csv",
]);

const JSON_FILE_TYPES = new Set([
  "application/json",
  "application/postman_collection+json",
]);

export type ParsedChunk = {
  chunkIndex: number;
  fullText: string;
  preview: string;
  chunkKind: "testcase_row" | "gherkin_scenario" | "requirement_section" | "paragraph" | "api_item";
  sourceLocator: string;
  metadata: Record<string, unknown>;
  tokenCount: number;
};

export function isSupportedDocument(fileType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();
  return (
    fileType === "application/pdf" ||
    TEXT_FILE_TYPES.has(fileType) ||
    JSON_FILE_TYPES.has(fileType) ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".feature") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".postman_collection.json") ||
    lowerName.endsWith(".yaml") ||
    lowerName.endsWith(".yml")
  );
}

export async function extractTextFromDocument(buffer: Buffer, fileType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();

  if (fileType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return normalizeText(parsed.text);
  }

  if (JSON_FILE_TYPES.has(fileType) || lowerName.endsWith(".json")) {
    const raw = buffer.toString("utf8");
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return normalizeText(raw);
    }
  }

  if (
    TEXT_FILE_TYPES.has(fileType) ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".feature") ||
    lowerName.endsWith(".yaml") ||
    lowerName.endsWith(".yml")
  ) {
    return normalizeText(buffer.toString("utf8"));
  }

  throw new Error(`Unsupported document type: ${fileType || fileName}`);
}

export function chunkText(text: string, maxWords = 512, overlapWords = 50): ParsedChunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const chunks: ParsedChunk[] = [];
  const step = Math.max(1, maxWords - overlapWords);

  for (let start = 0; start < words.length; start += step) {
    const chunkWords = words.slice(start, start + maxWords);
    const fullText = chunkWords.join(" ");
    chunks.push({
      chunkIndex: chunks.length,
      fullText,
      preview: fullText.slice(0, 200),
      chunkKind: "paragraph",
      sourceLocator: `words:${start + 1}-${start + chunkWords.length}`,
      metadata: {},
      tokenCount: chunkWords.length,
    });

    if (start + maxWords >= words.length) {
      break;
    }
  }

  return chunks;
}

export function chunkDocument(text: string, fileType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();
  const documentType = detectDocumentType(fileType, fileName);
  const decorate = (chunks: ParsedChunk[]) =>
    chunks.map((chunk) => enrichChunkMetadata(chunk, fileName, documentType));

  if (
    fileType === "text/csv" ||
    fileType === "application/csv" ||
    fileType === "application/x-csv" ||
    lowerName.endsWith(".csv")
  ) {
    return decorate(chunkCsvRows(text));
  }

  if (lowerName.endsWith(".feature")) {
    return decorate(chunkGherkin(text));
  }

  if (lowerName.endsWith(".json") || JSON_FILE_TYPES.has(fileType)) {
    return decorate(chunkJson(text));
  }

  if (lowerName.endsWith(".md") || lowerName.endsWith(".txt") || lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")) {
    return decorate(chunkSections(text));
  }

  return decorate(chunkSections(text));
}

function chunkCsvRows(text: string): ParsedChunk[] {
  const records = parseCsv(text, {
    bom: true,
    relaxColumnCount: true,
    relaxQuotes: true,
    skipEmptyLines: true,
    trim: true,
  }) as string[][];

  if (records.length === 0) {
    return [];
  }

  const header = records[0].map((cell) => String(cell || "").trim());
  const dataRows = records.length > 1 ? records.slice(1) : records;

  return dataRows.map((row, index) => {
    const cells = row.map((cell) => String(cell || "").trim());
    const metadata = csvMetadata(header, cells);
    const fullText = header.length > 0 ? formatCsvRow(header, cells) : cells.join("\n");

    return {
      chunkIndex: index,
      fullText,
      preview: fullText.replace(/\s+/g, " ").slice(0, 200),
      chunkKind: "testcase_row",
      sourceLocator: `row:${index + 2}`,
      metadata,
      tokenCount: countTokens(fullText),
    };
  });
}

function chunkGherkin(text: string): ParsedChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: ParsedChunk[] = [];
  let current: string[] = [];
  let scenarioName = "feature";

  for (const line of lines) {
    if (/^\s*(Scenario|Scenario Outline|Background):/i.test(line) && current.length > 0) {
      chunks.push(makeChunk(chunks.length, current.join("\n"), "gherkin_scenario", scenarioName, { scenarioName }));
      current = [];
    }

    const match = line.match(/^\s*(Scenario|Scenario Outline|Background):\s*(.+)$/i);
    if (match) {
      scenarioName = match[2].trim();
    }

    current.push(line);
  }

  if (current.some((line) => line.trim())) {
    chunks.push(makeChunk(chunks.length, current.join("\n"), "gherkin_scenario", scenarioName, { scenarioName }));
  }

  return chunks;
}

function chunkJson(text: string): ParsedChunk[] {
  try {
    const parsed = JSON.parse(text);
    const items = extractJsonItems(parsed);
    if (items.length > 0) {
      return items.map((item, index) =>
        makeChunk(index, JSON.stringify(item.value, null, 2), "api_item", item.locator, item.metadata),
      );
    }
  } catch {
    // Fall through to section chunking.
  }

  return chunkSections(text);
}

function chunkSections(text: string): ParsedChunk[] {
  const sections = splitSections(text);
  const chunks: ParsedChunk[] = [];

  for (const section of sections) {
    if (countTokens(section.text) <= 220) {
      chunks.push(makeChunk(chunks.length, section.text, section.kind, section.locator, section.metadata));
      continue;
    }

    for (const subChunk of chunkText(section.text, 180, 30)) {
      chunks.push({
        ...subChunk,
        chunkIndex: chunks.length,
        chunkKind: section.kind,
        sourceLocator: `${section.locator}:${subChunk.sourceLocator}`,
        metadata: section.metadata,
      });
    }
  }

  return chunks;
}

function splitSections(text: string) {
  const lines = text.split(/\r?\n/);
  const sections: Array<{
    text: string;
    kind: "requirement_section" | "paragraph";
    locator: string;
    metadata: Record<string, unknown>;
  }> = [];
  let heading = "Document";
  let current: string[] = [];

  function flush() {
    const body = current.join("\n").trim();
    if (!body) return;
    const kind = /requirement|acceptance|criteria|shall|must|should/i.test(`${heading}\n${body}`)
      ? "requirement_section"
      : "paragraph";
    sections.push({
      text: body,
      kind,
      locator: heading,
      metadata: {
        heading,
        domainKeywords: extractDomains(body),
      },
    });
    current = [];
  }

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line.trim())) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      current.push(line);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return sections;
}

function makeChunk(
  chunkIndex: number,
  fullText: string,
  chunkKind: ParsedChunk["chunkKind"],
  sourceLocator: string,
  metadata: Record<string, unknown>,
): ParsedChunk {
  const normalized = fullText.trim();
  return {
    chunkIndex,
    fullText: normalized,
    preview: normalized.replace(/\s+/g, " ").slice(0, 200),
    chunkKind,
    sourceLocator,
    metadata,
    tokenCount: countTokens(normalized),
  };
}

function normalizeText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function countTokens(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function csvMetadata(header: string[], cells: string[]) {
  const metadata: Record<string, unknown> = {};
  const metadataFields: Array<{ originalKey: string; normalizedKey: string; value: string }> = [];
  header.forEach((name, index) => {
    const key = normalizeKey(name);
    const value = cells[index]?.trim();
    if (key && value) {
      metadata[key] = value;
      metadataFields.push({ originalKey: name.trim(), normalizedKey: key, value });
    }
  });

  metadata.metadataFields = metadataFields;
  metadata.originalFields = Object.fromEntries(metadataFields.map((field) => [field.originalKey, field.value]));
  metadata.domainKeywords = extractDomains(cells.join(" "));
  addCanonicalCsvMetadata(metadata, metadataFields);
  return metadata;
}

function formatCsvRow(header: string[], cells: string[]) {
  return header
    .map((name, index) => `${name}: ${normalizeCsvCell(cells[index] || "")}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
}

function addCanonicalCsvMetadata(
  metadata: Record<string, unknown>,
  fields: Array<{ originalKey: string; normalizedKey: string; value: string }>,
) {
  const pick = (...keys: string[]) => {
    const normalizedKeys = keys.map(normalizeKey);
    return fields.find((field) => normalizedKeys.includes(field.normalizedKey))?.value;
  };

  metadata.title = metadata.title || pick("summary", "title", "name", "test case name", "test_case", "requirement");
  metadata.module = metadata.module || pick("module", "component", "area", "feature", "test scenario", "scenario");
  metadata.priority = metadata.priority || pick("priority", "prio", "p");
  metadata.severity = metadata.severity || pick("severity", "criticality", "impact");
  metadata.assignee = metadata.assignee || pick("assignee", "assigned to", "owner", "qa owner");
  metadata.status = metadata.status || pick("status", "state", "result");
  metadata.tags = metadata.tags || pick("tags", "labels", "label");
  metadata.test_steps = metadata.test_steps || pick("test steps", "steps", "step");
  metadata.test_data = metadata.test_data || pick("test data", "data");
  metadata.expected_result = metadata.expected_result || pick("expected result", "expected", "expected outcome");
}

function normalizeCsvCell(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function extractJsonItems(value: unknown, path = "$"): Array<{ locator: string; value: unknown; metadata: Record<string, unknown> }> {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const items: Array<{ locator: string; value: unknown; metadata: Record<string, unknown> }> = [];

  if (obj.item && Array.isArray(obj.item)) {
    obj.item.forEach((item, index) => {
      const itemObj = item as Record<string, unknown>;
      items.push({
        locator: `${path}.item[${index}]`,
        value: item,
        metadata: { title: itemObj.name, kind: "postman_item" },
      });
    });
  }

  if (obj.paths && typeof obj.paths === "object") {
    for (const [route, methods] of Object.entries(obj.paths as Record<string, unknown>)) {
      for (const [method, operation] of Object.entries((methods || {}) as Record<string, unknown>)) {
        items.push({
          locator: `${method.toUpperCase()} ${route}`,
          value: operation,
          metadata: { method: method.toUpperCase(), path: route, kind: "openapi_operation" },
        });
      }
    }
  }

  return items;
}

function extractDomains(value: string) {
  return Array.from(new Set(value.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []));
}

function detectDocumentType(fileType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".csv") || fileType.includes("csv")) return "csv";
  if (lowerName.endsWith(".feature")) return "gherkin";
  if (lowerName.endsWith(".json") || JSON_FILE_TYPES.has(fileType)) return "json";
  if (lowerName.endsWith(".md")) return "markdown";
  if (lowerName.endsWith(".pdf") || fileType === "application/pdf") return "pdf";
  if (lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")) return "yaml";
  return "text";
}

function enrichChunkMetadata(chunk: ParsedChunk, fileName: string, documentType: string): ParsedChunk {
  const metadata = { ...chunk.metadata };
  const heading = stringify(metadata.heading) || undefined;
  const title = stringify(metadata.title) || heading || firstUsefulLine(chunk.fullText);
  const metadataFields = normalizeMetadataFields(metadata);
  const detectedKeywords = extractKeywords(`${chunk.fullText} ${title || ""}`);
  const detectedEntities = extractEntities(chunk.fullText);
  const fieldText = metadataFields
    .flatMap((field) => [`${field.normalizedKey}: ${field.value}`, `${field.originalKey}: ${field.value}`])
    .join("\n");
  const searchableText = [
    `documentName: ${fileName}`,
    `documentType: ${documentType}`,
    `chunkKind: ${chunk.chunkKind}`,
    `sourceLocator: ${chunk.sourceLocator}`,
    title ? `title: ${title}` : "",
    heading ? `headingPath: ${heading}` : "",
    fieldText,
    chunk.fullText,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...chunk,
    metadata: {
      ...metadata,
      documentName: fileName,
      documentType,
      chunkKind: chunk.chunkKind,
      sourceLocator: chunk.sourceLocator,
      headingPath: heading || null,
      pageOrSection: chunk.sourceLocator,
      title: title || null,
      detectedEntities,
      detectedKeywords,
      metadataFields,
      searchableText,
    },
  };
}

function normalizeMetadataFields(metadata: Record<string, unknown>) {
  const existing = Array.isArray(metadata.metadataFields) ? metadata.metadataFields : [];
  const fields = existing
    .filter((field): field is { originalKey: string; normalizedKey: string; value: string } =>
      Boolean(field && typeof field === "object" && "normalizedKey" in field && "value" in field),
    )
    .map((field) => ({
      originalKey: String(field.originalKey || field.normalizedKey),
      normalizedKey: normalizeKey(String(field.normalizedKey)),
      value: String(field.value),
    }));

  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    const normalizedKey = normalizeKey(key);
    if (!fields.some((field) => field.normalizedKey === normalizedKey)) {
      fields.push({ originalKey: key, normalizedKey, value: String(value) });
    }
  }

  return fields;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function stringify(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstUsefulLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120) || "";
}

function extractKeywords(value: string) {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "will", "should", "must"]);
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9.\/_-]+/)
        .filter((word) => word.length > 2 && !stop.has(word)),
    ),
  ).slice(0, 40);
}

function extractEntities(value: string) {
  return {
    ids: Array.from(new Set(value.match(/\b[A-Z]{1,8}-\d+\b/g) || [])).slice(0, 20),
    domains: extractDomains(value),
    paths: Array.from(new Set(value.match(/\/[a-zA-Z0-9_./{}:-]+/g) || [])).slice(0, 20),
  };
}
