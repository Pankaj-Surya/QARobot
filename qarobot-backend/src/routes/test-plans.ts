import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { testPlans } from "../db/schema.js";
import { retrieveContext } from "../services/rag-service.js";
import { generateWithFeatureModel } from "../services/ai-adapter.js";
import { inspectAppPage, inspectConfiguredAppPage } from "../services/page-inspection.js";
import { resolveRagProject } from "../services/rag-projects.js";

const generatePlanSchema = z.object({
  name: z.string().optional(),
  scope: z.string().min(1),
  appUrl: z.string().url().optional().or(z.literal("")),
  ragProjectId: z.string().uuid().optional().nullable(),
  documentIds: z.array(z.string().uuid()).optional().default([]),
});

const savePlanSchema = z.object({
  name: z.string().min(1),
  scopeDescription: z.string().min(1),
  content: z.string().min(1),
  aiModelUsed: z.string().optional(),
  sourceDocumentIds: z.array(z.string()).optional().default([]),
});

export async function testPlansRoutes(app: FastifyInstance) {
  app.post("/generate", async (request, reply) => {
    const parsed = generatePlanSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid test plan request",
        details: parsed.error.flatten(),
      });
    }

    const body = parsed.data;
    const projectContext = await resolveRagProject({
      ragProjectId: body.ragProjectId,
      appUrl: body.appUrl || null,
      requirementText: body.scope,
    });

    if (projectContext.usage.mode === "ambiguous") {
      return reply.code(409).send({
        error: projectContext.usage.reason,
        ragUsage: projectContext.usage,
      });
    }

    const context = projectContext.documentIds.length > 0
      ? await retrieveContext(body.scope, projectContext.documentIds, { topK: 8, intent: "test_plan" })
      : { chunks: [], retrieval: undefined };
    const pageContext = body.appUrl ? await inspectConfiguredAppPage(body.appUrl) : null;

    let content: string;
    try {
      content = await generateWithFeatureModel("test_plan_generator", [
        {
          role: "system",
          content:
            "You are a senior QA test manager. Generate a standard, readable QA test plan in Markdown. The user's scope is the primary requirement. If an App URL live context is provided, use the inspected page title, visible UI, controls, forms, links, and warnings to shape scope, scenarios, risks, environment assumptions, and UI coverage. Retrieved RAG evidence is grounding/context and must not replace the scope. Do not include retrieval scores, chunk ids, or technical metadata. If evidence is weak, still produce a useful plan from the scope and live app context and clearly mark assumptions and missing requirement areas.",
        },
        {
          role: "user",
          content: `Plan name: ${body.name || "QA Test Plan"}\n\nScope / requirement:\n${body.scope}\n\nRAG usage:\n${formatRagUsage(projectContext.usage)}\n\nLive app context:\n${formatPageContext(pageContext)}\n\nRequired sections:\nTitle, Scope, Objective, Source Requirement Summary, In Scope, Out Of Scope, Test Strategy, Test Scenario Matrix, Test Data, Entry Criteria, Exit Criteria, Risks.\n\nRetrieved RAG evidence:\n${formatEvidence(context.chunks) || "No matching RAG evidence was used. Generate from the requirement and live app context only, and clearly mark assumptions."}`,
        },
      ]);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "LLM test plan generation failed",
      });
    }

    return {
      content,
      ragUsage: projectContext.usage,
      retrieval: context.retrieval,
      liveAppContext: pageContext,
    };
  });

  app.post("/save", async (request, reply) => {
    const parsed = savePlanSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid test plan save request",
        details: parsed.error.flatten(),
      });
    }

    const [plan] = await db.insert(testPlans).values(parsed.data).returning();
    return reply.code(201).send({ plan });
  });

  app.get("/", async () => {
    const plans = await db.select().from(testPlans).orderBy(desc(testPlans.createdAt));
    return { plans };
  });
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

function buildDraftPlan(
  name: string,
  scope: string,
  chunks: Array<{
    documentName: string;
    chunkIndex: number;
    preview: string;
    fullText: string;
    score: number;
    matchedTerms: string[];
    retrievalReason: string;
  }>,
) {
  const contextSummary =
    chunks.length > 0
      ? chunks
          .map((chunk, index) => `${index + 1}. ${chunk.documentName}: ${relevantExcerpt(chunk)}`)
          .join("\n")
      : "No relevant RAG evidence was found. Draft is based on the provided scope only.";

  const functionalAreas = inferFunctionalAreas(scope, chunks);
  const testScenarios = functionalAreas
    .map(
      (area, index) =>
        `| TS-${String(index + 1).padStart(3, "0")} | ${area} | Positive, negative, validation, and regression coverage | High |`,
    )
    .join("\n");

  return `# ${name}

## Scope
${scope}

## Objective
Validate the functional behavior, negative scenarios, regression impact, and acceptance criteria for the requested scope.

## Source Requirement Summary
${contextSummary}

## In Scope
- Functional workflows described in the selected requirement document.
- Validation and error handling for the same workflows.
- Role, permission, and security-sensitive behavior where mentioned.
- Regression checks for impacted existing behavior.

## Out Of Scope
- Requirements not present in the scope or retrieved RAG evidence.
- Performance, load, and security testing beyond explicitly mentioned acceptance behavior.
- Production data validation.

## Test Strategy
- Create positive, negative, boundary, and regression scenarios from the source requirement summary.
- Prioritize flows that affect authentication, data integrity, user access, or revenue-critical journeys.
- Mark stable repeated flows as automation candidates.

## Test Scenario Matrix
| Scenario ID | Area | Coverage | Priority |
|---|---|---|---|
${testScenarios}

## Test Data
| Data Type | Description | Owner |
|---|---|---|
| Valid user data | Accounts and inputs that satisfy the requirement | QA |
| Invalid user data | Inputs for validation and negative checks | QA |
| Role-based data | Users with relevant permissions where applicable | QA / Product |

## Entry Criteria
- Test environment is available.
- Required accounts and test data are prepared.
- Required source material is available in the RAG pipeline when applicable.
- Build is deployed and ready for QA.

## Exit Criteria
- Critical and high-priority test cases are executed.
- Blocking defects are triaged.
- Automation candidates are marked for script generation.
- Test evidence is attached to the QA run or ticket.

## Risks
- Missing or outdated requirements can reduce test coverage.
- Ambiguous acceptance criteria may require product clarification.
- Generated output must be reviewed before execution.
`;
}

function inferFunctionalAreas(
  scope: string,
  chunks: Array<{ fullText: string; matchedTerms: string[] }>,
) {
  const combined = `${scope} ${chunks.map((chunk) => chunk.fullText).join(" ")}`.toLowerCase();
  const areas = new Set<string>();

  const candidates = [
    ["login", "Authentication and login"],
    ["password", "Password validation and recovery"],
    ["role", "Role and permission behavior"],
    ["user", "User workflow"],
    ["payment", "Payment workflow"],
    ["checkout", "Checkout workflow"],
    ["upload", "File upload and processing"],
    ["search", "Search and filtering"],
    ["report", "Reports and exports"],
    ["error", "Error handling"],
    ["invalid", "Negative validation"],
  ];

  for (const [term, label] of candidates) {
    if (combined.includes(term)) {
      areas.add(label);
    }
  }

  for (const chunk of chunks) {
    for (const term of chunk.matchedTerms.slice(0, 2)) {
      areas.add(`${capitalize(term)} requirement coverage`);
    }
  }

  if (areas.size === 0) {
    areas.add("Core functional workflow");
    areas.add("Input validation and error handling");
    areas.add("Regression coverage");
  }

  return Array.from(areas).slice(0, 8);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function relevantExcerpt(chunk: { fullText: string; matchedTerms: string[]; preview: string }) {
  const lines = chunk.fullText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const term of chunk.matchedTerms) {
    const line = lines.find((candidate) => candidate.toLowerCase().includes(term));
    if (line) {
      return line.replace(/\s+/g, " ").slice(0, 260);
    }
  }

  return chunk.preview;
}
