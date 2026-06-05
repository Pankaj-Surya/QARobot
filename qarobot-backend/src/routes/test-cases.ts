import type { FastifyInstance } from "fastify";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { testCases } from "../db/schema.js";
import { retrieveContext } from "../services/rag-service.js";
import { generateWithFeatureModel, type ChatMessage } from "../services/ai-adapter.js";
import { inspectAppPage } from "../services/page-inspection.js";
import { resolveRagProject } from "../services/rag-projects.js";

const generateCasesSchema = z.object({
  featureDescription: z.string().min(1),
  appUrl: z.string().url().optional().or(z.literal("")),
  ragProjectId: z.string().uuid().optional().nullable(),
  documentIds: z.array(z.string().uuid()).optional().default([]),
  count: z.number().int().min(1).max(20).optional().default(5),
  mode: z.enum(["balanced", "positive", "negative", "regression"]).optional().default("balanced"),
});

const saveCasesSchema = z.object({
  cases: z
    .array(
      z.object({
        title: z.string().min(1),
        module: z.string().min(1),
        testType: z.string().min(1),
        priority: z.string().min(1),
        preconditions: z.string().optional().nullable(),
        steps: z.array(z.string()).default([]),
        testData: z.string().optional().nullable(),
        expectedResult: z.string().min(1),
        automationStatus: z.string().optional().default("manual"),
        linkedPlanId: z.string().uuid().optional().nullable(),
      }),
    )
    .min(1),
});

const generatedCaseSchema = z.object({
  title: z.string().min(1),
  module: z.string().min(1),
  testType: z.string().min(1),
  priority: z.string().min(1),
  preconditions: z.string().nullable().optional(),
  steps: z.array(z.string()).min(1),
  testData: z.string().nullable().optional(),
  expectedResult: z.string().min(1),
  automationStatus: z.string().optional().default("candidate"),
});

export async function testCasesRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .safeParse(request.query);
    const baseQuery = db.select().from(testCases).orderBy(desc(testCases.createdAt), desc(testCases.tcId));
    const rows = query.success && query.data.limit ? await baseQuery.limit(query.data.limit) : await baseQuery;
    return { testCases: rows };
  });

  app.post("/generate", async (request, reply) => {
    const parsed = generateCasesSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid test case generation request",
        details: parsed.error.flatten(),
      });
    }

    const { featureDescription, count, mode, appUrl, ragProjectId } = parsed.data;
    const projectContext = await resolveRagProject({
      ragProjectId,
      appUrl: appUrl || null,
      requirementText: featureDescription,
    });

    if (projectContext.usage.mode === "ambiguous") {
      return reply.code(409).send({
        error: projectContext.usage.reason,
        ragUsage: projectContext.usage,
      });
    }

    const context = projectContext.documentIds.length > 0
      ? await retrieveContext(featureDescription, projectContext.documentIds, { topK: Math.max(count, 6), intent: "test_case" })
      : { chunks: [], retrieval: undefined };
    const pageContext = appUrl ? await inspectAppPage(appUrl) : null;

    try {
      const messages = buildCaseGenerationMessages(featureDescription, mode, count, context.chunks, {
        ragUsage: projectContext.usage,
        pageContext,
      });
      const output = await generateWithFeatureModel("test_case_generator", messages);
      const cases = await parseGeneratedCases(output, messages, count);
      return { cases, retrieval: context.retrieval, ragUsage: projectContext.usage, liveAppContext: pageContext };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "LLM test case generation failed",
      });
    }
  });

  app.post("/save", async (request, reply) => {
    const parsed = saveCasesSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid test case save request",
        details: parsed.error.flatten(),
      });
    }

    const maxNumber = await getCurrentMaxTcNumber();
    const rows = parsed.data.cases.map((testCase, index) => ({
      ...testCase,
      tcId: `TC-${String(maxNumber + index + 1).padStart(3, "0")}`,
      preconditions: testCase.preconditions || null,
      testData: testCase.testData || null,
      linkedPlanId: testCase.linkedPlanId || null,
    }));

    const saved = await db.insert(testCases).values(rows).returning();
    return reply.code(201).send({ testCases: saved });
  });
}

function buildCaseGenerationMessages(
  featureDescription: string,
  mode: "balanced" | "positive" | "negative" | "regression",
  count: number,
  chunks: Array<{ documentName: string; sourceLocator: string | null; chunkIndex: number; fullText: string; metadata?: Record<string, unknown> }>,
  context: {
    ragUsage: Awaited<ReturnType<typeof resolveRagProject>>["usage"];
    pageContext: Awaited<ReturnType<typeof inspectAppPage>> | null;
  },
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'You are a senior QA engineer. Generate only valid JSON. The feature description is the primary source requirement. Retrieved RAG evidence is grounding/context only and must not replace the requirement. Return exactly one JSON object with shape {"cases":[...]}. Do not use markdown, comments, trailing commas, or extra text.',
    },
    {
      role: "user",
      content: `Feature requirement:\n${featureDescription}\n\nMode: ${mode}\nCount: ${count}\n\nRAG usage:\n${formatRagUsage(context.ragUsage)}\n\nLive app context:\n${formatPageContext(context.pageContext)}\n\nReturn exactly ${count} Jira-ready test cases inside {"cases":[...]}. Each case must include string fields title, module, testType, priority, expectedResult, automationStatus; nullable string fields preconditions and testData; and steps as an array of strings.\n\nIf the requirement mentions domain-based SSO login, cover: Google domain disables password and shows Google icon; Microsoft domain disables password and shows Microsoft icon; clicking provider sign-in opens SSO; non-configured domain keeps password login enabled; changing username domain updates login mode; blank/malformed username does not trigger SSO.\n\nRetrieved RAG evidence:\n${formatEvidence(chunks) || "No matching RAG evidence was used. Use the feature requirement and live app context only, and mark reasonable QA assumptions in preconditions where needed."}`,
    },
  ];
}

async function parseGeneratedCases(output: string, originalMessages: ChatMessage[], count: number) {
  const firstAttempt = parseGeneratedCasesOnce(output);
  if (firstAttempt.success) {
    return firstAttempt.cases.slice(0, count);
  }

  const repaired = await generateWithFeatureModel("test_case_generator", [
    ...originalMessages,
    {
      role: "assistant",
      content: output,
    },
    {
      role: "user",
      content: `Repair the previous response into valid JSON only. Return exactly {"cases":[...]} with ${count} cases. Schema per case: title string, module string, testType string, priority string, preconditions string|null, steps string[], testData string|null, expectedResult string, automationStatus string. Validation errors: ${firstAttempt.error}`,
    },
  ]);

  const secondAttempt = parseGeneratedCasesOnce(repaired);
  if (secondAttempt.success) {
    return secondAttempt.cases.slice(0, count);
  }

  throw new Error(`LLM returned invalid test case JSON after repair: ${secondAttempt.error}`);
}

function parseGeneratedCasesOnce(
  output: string,
): { success: true; cases: z.infer<typeof generatedCaseSchema>[] } | { success: false; error: string } {
  try {
    const jsonText = extractJsonPayload(output);
    const parsed = JSON.parse(jsonText) as unknown;
    const candidate = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.cases)
        ? parsed.cases
        : null;

    if (!candidate) {
      return { success: false, error: 'Response must be a JSON object with "cases" array or a JSON array.' };
    }

    const normalized = candidate.map(normalizeGeneratedCase);
    const result = z.array(generatedCaseSchema).safeParse(normalized);

    if (!result.success) {
      return { success: false, error: JSON.stringify(result.error.flatten()) };
    }

    return { success: true, cases: result.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unable to parse JSON." };
  }
}

function extractJsonPayload(output: string) {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0];
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  throw new Error("LLM response did not contain a JSON object or array.");
}

function normalizeGeneratedCase(value: unknown) {
  const row = isRecord(value) ? value : {};
  const rawSteps = row.steps ?? row.step ?? [];
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((step) => String(step)).filter(Boolean)
    : String(rawSteps)
        .split(/\r?\n|(?:^|\s)\d+[.)]\s|;/)
        .map((step) => step.trim())
        .filter(Boolean);

  return {
    title: stringifyField(row.title || row.name || "Generated test case"),
    module: stringifyField(row.module || "General"),
    testType: stringifyField(row.testType || row.type || "Functional"),
    priority: stringifyField(row.priority || "P2"),
    preconditions: nullableString(row.preconditions ?? row.precondition),
    steps: steps.length > 0 ? steps : ["Review the requirement", "Execute the described workflow", "Verify the expected result"],
    testData: nullableString(row.testData ?? row.data),
    expectedResult: stringifyField(row.expectedResult || row.expected || "Behavior matches the requirement"),
    automationStatus: stringifyField(row.automationStatus || "candidate"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyField(value: unknown) {
  return String(value ?? "").trim();
}

function nullableString(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function formatEvidence(chunks: Array<{ documentName: string; sourceLocator: string | null; chunkIndex: number; fullText: string; metadata?: Record<string, unknown> }>) {
  return chunks
    .map(
      (chunk, index) =>
        `[E${index + 1}] ${chunk.documentName} ${chunk.sourceLocator || `chunk ${chunk.chunkIndex + 1}`}\n${formatMetadataFields(chunk.metadata)}\n${chunk.fullText}`,
    )
    .join("\n\n---\n\n");
}

function formatMetadataFields(metadata: Record<string, unknown> | undefined) {
  const rawFields = Array.isArray(metadata?.metadataFields) ? metadata.metadataFields : [];
  return rawFields
    .filter((field) => field && typeof field === "object" && "normalizedKey" in field && "value" in field)
    .map((field) => {
      const row = field as Record<string, unknown>;
      return `${String(row.originalKey || row.normalizedKey)}: ${String(row.value)}`;
    })
    .join("\n");
}

function formatRagUsage(usage: Awaited<ReturnType<typeof resolveRagProject>>["usage"]) {
  if (usage.mode === "used") {
    return `RAG Project: ${usage.projectName}\nReason: ${usage.reason}\nSource types: ${usage.sourceTypes.join(", ") || "unknown"}`;
  }

  return `${usage.reason}\nDo not invent source evidence.`;
}

function formatPageContext(pageContext: Awaited<ReturnType<typeof inspectAppPage>> | null) {
  if (!pageContext) return "No App URL was provided.";
  return [
    `Mode: ${pageContext.mode}`,
    pageContext.title ? `Title: ${pageContext.title}` : "",
    pageContext.finalUrl ? `Final URL: ${pageContext.finalUrl}` : "",
    pageContext.headings?.length ? `Headings: ${pageContext.headings.slice(0, 8).join(" | ")}` : "",
    pageContext.buttons?.length ? `Buttons: ${pageContext.buttons.slice(0, 12).map((button) => button.text || button.selectorHint).join(" | ")}` : "",
    pageContext.inputs?.length ? `Inputs: ${pageContext.inputs.slice(0, 12).map((input) => input.label || input.placeholder || input.type).join(" | ")}` : "",
    pageContext.warnings?.length ? `Warnings: ${pageContext.warnings.join(" ")}` : "",
  ].filter(Boolean).join("\n");
}

async function getCurrentMaxTcNumber() {
  const [row] = await db
    .select({ max: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${testCases.tcId}, 4) AS INTEGER)), 0)` })
    .from(testCases);

  return Number(row?.max || 0);
}

function buildDraftCases(
  featureDescription: string,
  sourceTexts: string[],
  count: number,
  mode: "balanced" | "positive" | "negative" | "regression",
) {
  const requirementCases = buildRequirementDrivenCases(featureDescription, mode);
  if (requirementCases.length > 0) {
    return requirementCases.slice(0, count);
  }

  const patterns = selectPatterns(mode);

  return Array.from({ length: count }, (_, index) => {
    const evidence = cleanSource(featureDescription);
    const reference = cleanSource(sourceTexts[index % sourceTexts.length] || "");
    const pattern = patterns[index % patterns.length];
    const title = inferTitleFromRequirement(evidence, pattern.titlePrefix, pattern.intent);

    return {
      title,
      module: inferModule(evidence, reference),
      testType: pattern.testType,
      priority: pattern.priority,
      preconditions: inferPreconditionsFromRequirement(evidence),
      steps: buildStepsFromRequirement(evidence, pattern.intent),
      testData: inferTestData(evidence, pattern.intent),
      expectedResult: inferExpectedResultFromRequirement(evidence, pattern.intent),
      automationStatus: pattern.automationStatus,
    };
  });
}

function buildRequirementDrivenCases(
  featureDescription: string,
  mode: "balanced" | "positive" | "negative" | "regression",
) {
  const text = featureDescription.toLowerCase();
  const isDomainSsoLogin =
    text.includes("login") &&
    text.includes("domain") &&
    text.includes("password") &&
    text.includes("sso");

  if (!isDomainSsoLogin) {
    return [];
  }

  const domains = extractDomains(featureDescription);
  const knownDomains = domains.length > 0 ? domains : ["google.com", "microsoft.com"];
  const firstDomain = knownDomains[0];
  const secondDomain = knownDomains[1] || knownDomains[0];

  const cases = [
    {
      title: `Verify ${firstDomain} domain user sees SSO login option with password disabled`,
      module: "Auth",
      testType: "Functional",
      priority: "P1",
      preconditions: `${firstDomain} is configured as an SSO-enabled domain`,
      steps: [
        "Open the sign-in page",
        `Enter username user@${firstDomain}`,
        "Move focus away from the username field or wait for domain detection",
      ],
      testData: `user@${firstDomain}`,
      expectedResult: "Password field is disabled and the sign-in button shows the matching provider icon",
      automationStatus: "candidate",
    },
    {
      title: `Verify clicking ${firstDomain} SSO sign-in opens the SSO screen`,
      module: "Auth",
      testType: "Functional",
      priority: "P1",
      preconditions: `${firstDomain} is configured as an SSO-enabled domain`,
      steps: [
        "Open the sign-in page",
        `Enter username user@${firstDomain}`,
        "Click the provider sign-in button",
      ],
      testData: `user@${firstDomain}`,
      expectedResult: "User is redirected to the configured SSO screen for that provider",
      automationStatus: "candidate",
    },
    {
      title: `Verify ${secondDomain} domain shows Microsoft SSO behavior when configured`,
      module: "Auth",
      testType: "Functional",
      priority: "P1",
      preconditions: `${secondDomain} is configured as an SSO-enabled domain`,
      steps: [
        "Open the sign-in page",
        `Enter username user@${secondDomain}`,
        "Observe the sign-in button and password field",
      ],
      testData: `user@${secondDomain}`,
      expectedResult: "Password field is disabled and the sign-in button shows the configured Microsoft/provider icon",
      automationStatus: "candidate",
    },
    {
      title: "Validate non-configured domain keeps password login enabled",
      module: "Auth",
      testType: "Negative",
      priority: "P1",
      preconditions: "User enters a domain that is not configured for SSO",
      steps: [
        "Open the sign-in page",
        "Enter username user@example.org",
        "Observe the password field and sign-in button",
      ],
      testData: "user@example.org",
      expectedResult: "Password field remains enabled and no Google/Microsoft SSO icon is shown",
      automationStatus: "candidate",
    },
    {
      title: "Validate changing username domain updates login mode immediately",
      module: "Auth",
      testType: "Regression",
      priority: "P2",
      preconditions: "At least one SSO domain and one non-SSO domain are available",
      steps: [
        `Enter username user@${firstDomain}`,
        "Confirm password field is disabled",
        "Change username to user@example.org",
      ],
      testData: `user@${firstDomain}, user@example.org`,
      expectedResult: "Login form switches back to password mode without stale provider icon or disabled password state",
      automationStatus: "candidate",
    },
    {
      title: "Validate blank or malformed username does not trigger SSO mode",
      module: "Auth",
      testType: "Boundary",
      priority: "P2",
      preconditions: "Sign-in page is available",
      steps: [
        "Open the sign-in page",
        "Leave username blank or enter malformed value without a valid domain",
        "Observe password field and sign-in button",
      ],
      testData: "blank username, user@, user",
      expectedResult: "Password field remains available only when appropriate and SSO provider icon is not shown for invalid domain input",
      automationStatus: "manual",
    },
  ];

  if (mode === "positive") {
    return cases.filter((testCase) => testCase.testType === "Functional");
  }

  if (mode === "negative") {
    return cases.filter((testCase) => ["Negative", "Boundary"].includes(testCase.testType));
  }

  if (mode === "regression") {
    return cases.filter((testCase) => testCase.testType === "Regression");
  }

  return cases;
}

function selectPatterns(mode: "balanced" | "positive" | "negative" | "regression") {
  const all = {
    positive: [
      { titlePrefix: "Verify", testType: "Functional", priority: "P1", intent: "positive", automationStatus: "candidate" },
    ],
    negative: [
      { titlePrefix: "Validate error handling for", testType: "Negative", priority: "P1", intent: "negative", automationStatus: "candidate" },
    ],
    regression: [
      { titlePrefix: "Regression check for", testType: "Regression", priority: "P2", intent: "regression", automationStatus: "candidate" },
    ],
    balanced: [
      { titlePrefix: "Verify", testType: "Functional", priority: "P1", intent: "positive", automationStatus: "candidate" },
      { titlePrefix: "Validate error handling for", testType: "Negative", priority: "P1", intent: "negative", automationStatus: "candidate" },
      { titlePrefix: "Regression check for", testType: "Regression", priority: "P2", intent: "regression", automationStatus: "candidate" },
      { titlePrefix: "Validate boundary behavior for", testType: "Boundary", priority: "P2", intent: "boundary", automationStatus: "manual" },
    ],
  };

  return all[mode];
}

function cleanSource(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function inferTitleFromRequirement(requirement: string, prefix: string, intent: string) {
  const subject = summarizeRequirementSubject(requirement);

  if (intent === "negative") {
    return `Validate error handling for ${subject}`.slice(0, 180);
  }

  if (intent === "regression") {
    return `Regression check for ${subject}`.slice(0, 180);
  }

  if (intent === "boundary") {
    return `Validate boundary behavior for ${subject}`.slice(0, 180);
  }

  return `${prefix} ${subject}`.slice(0, 180);
}

function inferModule(evidence: string, fallback: string) {
  const csvCells = parseCsvLine(evidence);
  if (csvCells[3]) {
    return csvCells[3];
  }

  const combined = `${evidence} ${fallback}`.toLowerCase();
  if (combined.includes("login") || combined.includes("auth")) return "Auth";
  if (combined.includes("payment") || combined.includes("billing")) return "Billing";
  if (combined.includes("upload")) return "Documents";
  if (combined.includes("report")) return "Reports";
  return "General";
}

function inferPreconditionsFromRequirement(requirement: string) {
  if (requirement.toLowerCase().includes("login")) {
    return "Sign-in page is available and domain configuration exists in QA";
  }

  return "Feature is available in the QA environment";
}

function buildStepsFromRequirement(evidence: string, intent: string) {
  if (intent === "negative") {
    return ["Open the target workflow", "Enter invalid or incomplete data", "Submit the form or action"];
  }

  if (intent === "regression") {
    return ["Open the existing workflow", "Perform the previously supported action", "Confirm the behavior remains unchanged"];
  }

  return ["Open the target workflow", "Enter valid data", "Submit the form or action"];
}

function inferTestData(evidence: string, intent: string) {
  if (intent === "negative") return "Invalid, missing, or unauthorized input";
  if (intent === "boundary") return "Minimum, maximum, and edge input values";
  return evidence.toLowerCase().includes("user") ? "Valid QA user account" : "Valid QA test data";
}

function inferExpectedResult(evidence: string, intent: string) {
  const csvCells = parseCsvLine(evidence);
  if (csvCells[9]) {
    return csvCells[9];
  }

  if (intent === "negative") return "System shows a clear validation error and does not complete the action";
  if (intent === "regression") return "Existing behavior remains stable";
  return "System completes the workflow successfully";
}

function inferExpectedResultFromRequirement(requirement: string, intent: string) {
  const text = requirement.toLowerCase();

  if (text.includes("disable password") || text.includes("password field")) {
    if (intent === "negative") {
      return "Password field is not disabled for domains that are not configured for SSO";
    }

    return "Configured domain disables password login and shows the appropriate SSO provider sign-in option";
  }

  if (text.includes("sso")) {
    return "User is routed to the correct SSO screen";
  }

  if (intent === "negative") return "System shows a clear validation error and does not complete the action";
  if (intent === "regression") return "Existing behavior remains stable";
  return "System completes the workflow successfully";
}

function summarizeRequirementSubject(requirement: string) {
  const text = requirement.toLowerCase();

  if (text.includes("login") && text.includes("domain") && text.includes("sso")) {
    return "domain-based SSO login behavior";
  }

  if (text.includes("login")) {
    return "login behavior";
  }

  return firstSentence(requirement) || "requested behavior";
}

function extractDomains(value: string) {
  return Array.from(new Set(value.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []));
}

function firstSentence(text: string) {
  return text.split(/[.!?]/)[0]?.trim();
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}
