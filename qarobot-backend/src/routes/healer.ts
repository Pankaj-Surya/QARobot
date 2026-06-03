import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { runnerSettings, testRuns, testScripts } from "../db/schema.js";
import { generateWithFeatureModel } from "../services/ai-adapter.js";

const analyzeSchema = z.object({
  runId: z.string().uuid(),
});

type RunResults = {
  scriptName?: string;
  appUrl?: string | null;
  browser?: string;
  tests?: Array<{ title?: string; status?: string; error?: string; durationMs?: number }>;
  stdout?: string;
  stderr?: string;
  logs?: Array<{ type?: string; message?: string; at?: string }>;
  sourceSpec?: string;
};

type PageContext = {
  mode?: string;
  title?: string;
  finalUrl?: string;
  headings?: string[];
  buttons?: Array<{ text?: string; selectorHint?: string }>;
  links?: Array<{ text?: string; href?: string; selectorHint?: string }>;
  inputs?: Array<{ label?: string; placeholder?: string; type?: string; selectorHint?: string }>;
  visibleText?: string[];
  warnings?: string[];
};

type HealSuggestion = {
  summary: string;
  rootCause: string;
  brokenSelectors: string[];
  suggestedChanges: string[];
  fixedSpec: string;
  confidence: number;
  warnings: string[];
  usedModel: boolean;
};

export async function healerRoutes(app: FastifyInstance) {
  app.get("/candidates", async () => {
    const rows = await db
      .select({
        id: testRuns.id,
        scriptId: testRuns.scriptId,
        status: testRuns.status,
        browser: testRuns.browser,
        startedAt: testRuns.startedAt,
        completedAt: testRuns.completedAt,
        failedCount: testRuns.failedCount,
        results: testRuns.results,
      })
      .from(testRuns)
      .where(eq(testRuns.status, "failed"))
      .orderBy(desc(testRuns.startedAt))
      .limit(20);

    return {
      runs: rows.map((run) => {
        const results = normalizeResults(run.results);
        return {
          id: run.id,
          scriptId: run.scriptId,
          status: run.status,
          browser: run.browser,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          failedCount: run.failedCount,
          scriptName: results.scriptName || "Unknown script",
          appUrl: results.appUrl || null,
          failureSummary: summarizeFailure(results),
        };
      }),
    };
  });

  app.get("/logs", async () => ({
    healLogs: [],
  }));

  app.post("/analyze", async (request, reply) => {
    const parsed = analyzeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid healer request", details: parsed.error.flatten() });
    }

    const [run] = await db.select().from(testRuns).where(eq(testRuns.id, parsed.data.runId)).limit(1);
    if (!run) return reply.code(404).send({ error: "Run not found." });
    if (run.status !== "failed") return reply.code(400).send({ error: "Only failed runs can be healed." });

    const results = normalizeResults(run.results);
    const sourceSpec = await loadSourceSpec(run.scriptId, results);
    if (!sourceSpec) {
      return reply.code(400).send({
        error: "No script source is available for this failed run. Run the script again after the latest runner update or use a saved script.",
      });
    }

    const pageContext = results.appUrl ? await inspectPageContext(results.appUrl) : { mode: "unavailable", warnings: ["Run has no app URL."] };
    const failureText = buildFailureText(results);
    const deterministic = deterministicSuggestion(sourceSpec, failureText, pageContext);

    try {
      const modelSuggestion = await modelHeal(sourceSpec, failureText, pageContext, deterministic);
      return { suggestion: modelSuggestion, run: runSummary(run.id, results), pageContext };
    } catch (error) {
      return {
        suggestion: {
          ...deterministic,
          warnings: [
            ...deterministic.warnings,
            `Healing model was not used: ${error instanceof Error ? error.message : "unknown error"}`,
          ],
        },
        run: runSummary(run.id, results),
        pageContext,
      };
    }
  });
}

async function loadSourceSpec(scriptId: string | null, results: RunResults) {
  if (results.sourceSpec) return results.sourceSpec;
  if (!scriptId) return "";

  const [script] = await db.select().from(testScripts).where(eq(testScripts.id, scriptId)).limit(1);
  if (!script) return "";
  return script.files["tests/generated.spec.ts"] || script.files["tests/pasted.spec.ts"] || Object.entries(script.files)
    .filter(([file]) => file.endsWith(".spec.ts") || file.endsWith(".test.ts"))
    .map(([, content]) => content)
    .join("\n");
}

async function inspectPageContext(appUrl: string): Promise<PageContext> {
  const [settings] = await db.select().from(runnerSettings).where(eq(runnerSettings.key, "default")).limit(1);
  if (!settings?.workerUrl) {
    return { mode: "unavailable", warnings: ["Runner worker URL is not configured, so DOM inspection was skipped."] };
  }

  try {
    const response = await fetch(`${settings.workerUrl.replace(/\/$/, "")}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appUrl }),
    });
    const text = await response.text();
    if (!response.ok) {
      return { mode: "unavailable", warnings: [`Runner inspection failed with ${response.status}: ${limit(text, 500)}`] };
    }
    return text ? JSON.parse(text) as PageContext : { mode: "unavailable", warnings: ["Runner inspection returned an empty response."] };
  } catch (error) {
    return { mode: "unavailable", warnings: [`Runner inspection failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
}

async function modelHeal(
  sourceSpec: string,
  failureText: string,
  pageContext: PageContext,
  fallback: HealSuggestion,
): Promise<HealSuggestion> {
  const response = await generateWithFeatureModel(
    "test_healer",
    [
      {
        role: "system",
        content:
          'You are a senior Playwright test healer. Return only valid JSON with shape {"summary":"...","rootCause":"...","brokenSelectors":["..."],"suggestedChanges":["..."],"fixedSpec":"...","confidence":0.8,"warnings":["..."]}. Keep the fixedSpec as one simple Playwright TypeScript spec. Do not add page objects, helper files, or explanations outside JSON. Prefer role, label, placeholder, text, id, name, and test id selectors from DOM context. Preserve test intent.',
      },
      {
        role: "user",
        content: JSON.stringify({
          failedRun: limit(failureText, 8000),
          originalSpec: limit(sourceSpec, 12000),
          pageContext: compactPageContext(pageContext),
          fallbackSuggestion: fallback,
        }),
      },
    ],
    { maxTokens: 6000 },
  );

  const parsed = parseJsonObject(response);
  return normalizeSuggestion(parsed, sourceSpec, true);
}

function deterministicSuggestion(sourceSpec: string, failureText: string, pageContext: PageContext): HealSuggestion {
  const brokenSelectors = extractBrokenSelectors(failureText);
  const suggestedChanges = buildSelectorSuggestions(brokenSelectors, pageContext);
  return {
    summary: "QA Robot found a failed Playwright run and prepared a healing checklist.",
    rootCause: brokenSelectors.length > 0
      ? "The failure appears related to a selector or assertion waiting for an element that was not found."
      : "The failure could not be mapped to one exact selector from the runner output.",
    brokenSelectors,
    suggestedChanges,
    fixedSpec: sourceSpec,
    confidence: brokenSelectors.length > 0 ? 0.45 : 0.25,
    warnings: [
      "Deterministic fallback did not rewrite the script automatically. Select a healing model for stronger fixes.",
      ...(pageContext.warnings || []),
    ],
    usedModel: false,
  };
}

function buildSelectorSuggestions(brokenSelectors: string[], pageContext: PageContext) {
  const options = [
    ...(pageContext.buttons || []).map((item) => item.text ? `Try button role/text selector for "${item.text}" (${item.selectorHint || "no hint"}).` : ""),
    ...(pageContext.links || []).map((item) => item.text ? `Try link role/text selector for "${item.text}" (${item.selectorHint || "no hint"}).` : ""),
    ...(pageContext.inputs || []).map((item) => `Try input selector from label/placeholder "${item.label || item.placeholder || item.type || "input"}" (${item.selectorHint || "no hint"}).`),
  ].filter(Boolean).slice(0, 8);

  if (brokenSelectors.length === 0) return options.length > 0 ? options : ["Review the latest trace, screenshot, and HTML report to identify the new locator."];
  return brokenSelectors.flatMap((selector) => [
    `Replace or relax broken selector: ${selector}`,
    ...options.slice(0, 3),
  ]).slice(0, 12);
}

function extractBrokenSelectors(text: string) {
  const selectors = new Set<string>();
  const patterns = [
    /Locator:\s*([^\n\r]+)/gi,
    /waiting for\s+([^\n\r]+)/gi,
    /(getBy(?:Role|Text|Label|Placeholder|TestId)\([^\n\r]+?\))/gi,
    /(locator\([^\n\r]+?\))/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = clean(match[1]);
      if (value && value.length < 300) selectors.add(value);
    }
  }

  return [...selectors].slice(0, 10);
}

function normalizeResults(value: unknown): RunResults {
  return value && typeof value === "object" ? value as RunResults : {};
}

function buildFailureText(results: RunResults) {
  const failedTests = (results.tests || [])
    .filter((test) => test.status !== "passed")
    .map((test) => `Test: ${test.title || "unknown"}\nStatus: ${test.status || "unknown"}\nError: ${test.error || ""}`)
    .join("\n\n");
  const logs = (results.logs || []).map((entry) => `[${entry.type || "info"}] ${entry.message || ""}`).join("\n");
  return [failedTests, results.stderr, results.stdout, logs].filter(Boolean).join("\n\n");
}

function summarizeFailure(results: RunResults) {
  const failed = (results.tests || []).find((test) => test.status !== "passed");
  return limit(failed?.error || results.stderr || results.logs?.find((log) => log.type === "fail")?.message || "Failed run has no detailed error.", 300);
}

function runSummary(id: string, results: RunResults) {
  return {
    id,
    scriptName: results.scriptName || "Unknown script",
    appUrl: results.appUrl || null,
    browser: results.browser || "chromium",
  };
}

function compactPageContext(context: PageContext) {
  return {
    mode: context.mode,
    title: context.title,
    finalUrl: context.finalUrl,
    headings: (context.headings || []).slice(0, 20),
    buttons: (context.buttons || []).slice(0, 30),
    links: (context.links || []).slice(0, 30),
    inputs: (context.inputs || []).slice(0, 30),
    visibleText: (context.visibleText || []).slice(0, 80),
    warnings: context.warnings || [],
  };
}

function normalizeSuggestion(value: Record<string, unknown>, sourceSpec: string, usedModel: boolean): HealSuggestion {
  return {
    summary: stringField(value.summary, "Healing analysis completed."),
    rootCause: stringField(value.rootCause, "The failure likely comes from a stale selector or changed page behavior."),
    brokenSelectors: stringArray(value.brokenSelectors),
    suggestedChanges: stringArray(value.suggestedChanges),
    fixedSpec: stringField(value.fixedSpec, sourceSpec),
    confidence: Math.max(0, Math.min(1, Number(value.confidence ?? 0.6))),
    warnings: stringArray(value.warnings),
    usedModel,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || !candidate.trim().startsWith("{")) throw new Error("Healing model returned non-JSON output.");
  return JSON.parse(candidate) as Record<string, unknown>;
}

function stringField(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function clean(value: string) {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function limit(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
