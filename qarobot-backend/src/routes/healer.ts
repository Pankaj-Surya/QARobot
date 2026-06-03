import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { runnerSettings, testRuns, testScripts } from "../db/schema.js";
import { generateWithFeatureModel } from "../services/ai-adapter.js";

const analyzeSchema = z.object({
  runId: z.string().uuid(),
  maxAttempts: z.number().int().min(1).max(5).optional().default(3),
});

const saveHealedScriptSchema = z.object({
  runId: z.string().uuid(),
  name: z.string().min(1),
  appUrl: z.string().url(),
  fixedSpec: z.string().min(1),
});

type RunResults = {
  scriptName?: string;
  appUrl?: string | null;
  browser?: string;
  headed?: boolean;
  tests?: Array<{ title?: string; status?: string; error?: string; durationMs?: number }>;
  stdout?: string;
  stderr?: string;
  logs?: Array<{ type?: string; message?: string; at?: string }>;
  sourceSpec?: string;
  artifacts?: unknown;
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

type FailureClassification =
  | "selector_missing"
  | "assertion_mismatch"
  | "url_navigation"
  | "timeout"
  | "test_data"
  | "app_unavailable"
  | "auth_session"
  | "script_syntax"
  | "unknown";

type HealAttempt = {
  attempt: number;
  strategy: "deterministic" | "llm";
  status: "passed" | "failed" | "skipped";
  summary: string;
  rootCause: string;
  brokenSelectors: string[];
  suggestedChanges: string[];
  fixedSpec: string;
  confidence: number;
  validationRunId?: string;
  validationReport?: unknown;
  artifacts?: unknown;
  error?: string;
  warnings: string[];
};

type HealCandidate = Omit<HealAttempt, "attempt" | "status" | "validationRunId" | "validationReport" | "artifacts" | "error">;

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
          failureClassification: classifyFailure(buildFailureText(results)),
        };
      }),
    };
  });

  app.get("/logs", async () => ({ healLogs: [] }));

  app.post("/analyze", async (request, reply) => {
    const parsed = analyzeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid healer request", details: parsed.error.flatten() });
    const result = await analyzeAndValidate(parsed.data.runId, 1);
    return { suggestion: result.attempts[0], ...result };
  });

  app.post("/analyze-and-validate", async (request, reply) => {
    const parsed = analyzeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid healer request", details: parsed.error.flatten() });
    return analyzeAndValidate(parsed.data.runId, parsed.data.maxAttempts);
  });

  app.post("/save-script", async (request, reply) => {
    const parsed = saveHealedScriptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid healed script", details: parsed.error.flatten() });

    const files = buildHealedScriptFiles(parsed.data.appUrl, parsed.data.fixedSpec);
    const [script] = await db
      .insert(testScripts)
      .values({
        name: parsed.data.name,
        framework: "playwright",
        appUrl: parsed.data.appUrl,
        inputMode: "manual",
        manualTestCaseText: `Healed from failed run ${parsed.data.runId}`,
        testCaseIds: [],
        files,
        generationWarnings: [`Validated healed script generated from run ${parsed.data.runId}.`],
        pageContext: null,
      })
      .returning();

    return reply.code(201).send({ script });
  });
}

async function analyzeAndValidate(runId: string, maxAttempts: number) {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
  if (!run) throw new Error("Run not found.");
  if (run.status !== "failed") throw new Error("Only failed runs can be healed.");

  const settings = await loadRunnerSettings();
  if (!settings.workerUrl) throw new Error("Runner worker is not configured. Test and save a worker connection first.");

  const results = normalizeResults(run.results);
  const sourceSpec = await loadSourceSpec(run.scriptId, results);
  if (!sourceSpec) throw new Error("No script source is available for this failed run. Run the script again after the latest runner update or use a saved script.");

  const failureText = buildFailureText(results);
  const failureClassification = classifyFailure(failureText);
  const pageContext = results.appUrl ? await inspectPageContext(results.appUrl, settings.workerUrl) : { mode: "unavailable", warnings: ["Run has no app URL."] };
  const originalArtifacts = extractArtifacts(results.artifacts);
  const attempts: HealAttempt[] = [];
  const warnings = [...(pageContext.warnings || [])];
  let bestSpec = sourceSpec;
  let finalStatus: "healed" | "not_healed" | "needs_manual_review" = "needs_manual_review";
  let validationRunId = "";
  let confidence = 0.2;

  for (let index = 0; index < maxAttempts; index += 1) {
    const candidate = index === 0
      ? deterministicHeal(sourceSpec, failureText, pageContext, failureClassification)
      : await llmHeal(sourceSpec, failureText, pageContext, failureClassification, attempts).catch((error) => ({
        ...deterministicHeal(bestSpec, failureText, pageContext, failureClassification),
        strategy: "deterministic" as const,
        summary: "Healing model was unavailable; retried deterministic repair.",
        warnings: [`Healing model was not used: ${error instanceof Error ? error.message : "unknown error"}`],
      }));

    const fixedSpec = ensurePlaywrightImport(candidate.fixedSpec || bestSpec);
    bestSpec = fixedSpec;

    const validation = await validateHealedSpec(settings.workerUrl, runId, results, fixedSpec, index + 1).catch((error) => ({
      status: "failed",
      validationRunId: "",
      report: { tests: [{ title: "Validation dispatch", status: "failed", error: error instanceof Error ? error.message : "unknown error" }] },
      logs: [],
    }));

    const validationStatus = validation.status === "passed" ? "passed" : "failed";
    validationRunId = validation.validationRunId || validationRunId;
    confidence = validationStatus === "passed" ? 0.99 : Math.max(confidence, candidate.confidence);

    attempts.push({
      ...candidate,
      attempt: index + 1,
      status: validationStatus,
      fixedSpec,
      validationRunId: validation.validationRunId,
      validationReport: validation.report,
      artifacts: (validation.report as { artifacts?: unknown })?.artifacts,
      error: validationStatus === "failed" ? summarizeValidationFailure(validation.report) : undefined,
      warnings: [...candidate.warnings, ...warnings],
    });

    if (validationStatus === "passed") {
      finalStatus = "healed";
      break;
    }
  }

  if (finalStatus !== "healed") {
    const classificationBlocksAutoFix = ["app_unavailable", "auth_session", "test_data"].includes(failureClassification);
    finalStatus = classificationBlocksAutoFix ? "needs_manual_review" : "not_healed";
  }

  return {
    run: runSummary(run.id, results),
    originalFailureSummary: summarizeFailure(results),
    failureClassification,
    originalArtifacts,
    pageContext,
    attempts,
    finalStatus,
    fixedSpec: finalStatus === "healed" ? attempts.find((attempt) => attempt.status === "passed")?.fixedSpec || bestSpec : "",
    bestCandidateSpec: bestSpec,
    confidence,
    validationRunId,
    warnings: unique([...warnings, ...attempts.flatMap((attempt) => attempt.warnings)]),
  };
}

async function loadSourceSpec(scriptId: string | null, results: RunResults) {
  if (results.sourceSpec) return results.sourceSpec;
  if (!scriptId) return "";

  const [script] = await db.select().from(testScripts).where(eq(testScripts.id, scriptId)).limit(1);
  if (!script) return "";
  return getRunnableSpec(script.files);
}

async function loadRunnerSettings() {
  const [settings] = await db.select().from(runnerSettings).where(eq(runnerSettings.key, "default")).limit(1);
  return {
    workerUrl: settings?.workerUrl || process.env.RUNNER_WORKER_URL || "",
  };
}

async function inspectPageContext(appUrl: string, workerUrl: string): Promise<PageContext> {
  try {
    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appUrl }),
    });
    const text = await response.text();
    if (!response.ok) return { mode: "unavailable", warnings: [`Runner inspection failed with ${response.status}: ${limit(text, 500)}`] };
    return text ? JSON.parse(text) as PageContext : { mode: "unavailable", warnings: ["Runner inspection returned an empty response."] };
  } catch (error) {
    return { mode: "unavailable", warnings: [`Runner inspection failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
}

function deterministicHeal(sourceSpec: string, failureText: string, pageContext: PageContext, failureClassification: FailureClassification): HealCandidate {
  const brokenSelectors = extractBrokenSelectors(failureText);
  let fixedSpec = repairSyntax(sourceSpec);
  fixedSpec = repairUrlAssertions(fixedSpec, failureText);
  fixedSpec = repairSelectorText(fixedSpec, brokenSelectors, pageContext);
  fixedSpec = repairTimeouts(fixedSpec, failureText);

  return {
    strategy: "deterministic",
    summary: "Generated a deterministic minimal repair and validated it with the runner.",
    rootCause: rootCauseFor(failureClassification),
    brokenSelectors,
    suggestedChanges: buildSelectorSuggestions(brokenSelectors, pageContext, failureClassification),
    fixedSpec,
    confidence: fixedSpec !== sourceSpec ? 0.65 : 0.35,
    warnings: [],
  };
}

async function llmHeal(
  sourceSpec: string,
  failureText: string,
  pageContext: PageContext,
  failureClassification: FailureClassification,
  attempts: HealAttempt[],
): Promise<HealCandidate> {
  const response = await generateWithFeatureModel(
    "test_healer",
    [
      {
        role: "system",
        content:
          'You are a senior Playwright test healer. Return only valid JSON with shape {"summary":"...","rootCause":"...","brokenSelectors":["..."],"suggestedChanges":["..."],"fixedSpec":"...","confidence":0.8,"warnings":["..."]}. The fixedSpec must be one simple Playwright TypeScript spec. Do not add page objects, helper files, fixtures, or explanations outside JSON. Make the smallest change needed to preserve test intent. Use DOM candidates and previous validation failures.',
      },
      {
        role: "user",
        content: JSON.stringify({
          failureClassification,
          failedRun: limit(failureText, 8000),
          originalSpec: limit(sourceSpec, 12000),
          pageContext: compactPageContext(pageContext),
          previousAttempts: attempts.map((attempt) => ({
            attempt: attempt.attempt,
            strategy: attempt.strategy,
            status: attempt.status,
            error: attempt.error,
            suggestedChanges: attempt.suggestedChanges,
          })),
        }),
      },
    ],
    { maxTokens: 6000 },
  );

  const parsed = parseJsonObject(response);
  return normalizeCandidate(parsed, sourceSpec, "llm");
}

async function validateHealedSpec(
  workerUrl: string,
  originalRunId: string,
  results: RunResults,
  fixedSpec: string,
  attempt: number,
) {
  const appUrl = results.appUrl;
  if (!appUrl) throw new Error("Run has no app URL.");

  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/runner/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: `${originalRunId}-attempt-${attempt}`,
      purpose: "healing_validation",
      script: {
        id: `${originalRunId}-healed-${attempt}`,
        name: `${results.scriptName || "Healed script"} validation ${attempt}`,
        framework: "playwright",
        appUrl,
        files: buildHealedScriptFiles(appUrl, fixedSpec),
      },
      browser: results.browser || "chromium",
      headed: false,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Validation worker returned ${response.status}: ${limit(text, 1000)}`);
  return JSON.parse(text) as { validationRunId: string; status: "passed" | "failed"; report: unknown; logs: unknown[] };
}

function buildHealedScriptFiles(appUrl: string, fixedSpec: string) {
  return {
    "package.json": JSON.stringify({
      scripts: { test: "playwright test" },
      devDependencies: {
        "@playwright/test": "^1.44.0",
        typescript: "^5.5.3",
      },
    }, null, 2),
    "playwright.config.ts": `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  retries: 0,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["line"],
  ],
  use: {
    baseURL: process.env.BASE_URL || ${JSON.stringify(appUrl)},
    trace: "on",
    screenshot: "on",
    video: "on",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
`,
    "tests/generated.spec.ts": ensurePlaywrightImport(fixedSpec),
  };
}

function classifyFailure(text: string): FailureClassification {
  const lower = text.toLowerCase();
  if (/syntaxerror|unexpected token|typescript|compilation|cannot find name/i.test(text)) return "script_syntax";
  if (/net::|err_http|err_connection|err_timed_out|navigation failed|site rejected/i.test(text)) return "app_unavailable";
  if (/unauthorized|forbidden|login required|session|auth|captcha/i.test(text)) return "auth_session";
  if (/test data|invalid user|invalid password|not found in data/i.test(text)) return "test_data";
  if (/tohaveurl|expected.*url|url.*expected/i.test(text)) return "url_navigation";
  if (/timeout|timed out|waiting for/i.test(text)) return /locator|getby|element/i.test(lower) ? "selector_missing" : "timeout";
  if (/expect\(.*\)|expected.*received|tobevisible|tocontaintext|tohavetext/i.test(text)) return "assertion_mismatch";
  if (/locator|getbyrole|getbytext|getbylabel|getbyplaceholder/i.test(text)) return "selector_missing";
  return "unknown";
}

function rootCauseFor(classification: FailureClassification) {
  const labels: Record<FailureClassification, string> = {
    selector_missing: "A locator or assertion target was not found in the current page DOM.",
    assertion_mismatch: "The page loaded, but the expected assertion does not match current UI behavior.",
    url_navigation: "The expected URL or navigation timing differs from the actual browser result.",
    timeout: "The script waited too long for an action or assertion to complete.",
    test_data: "The failure appears tied to test data or input values rather than selector structure.",
    app_unavailable: "The app or target page was unavailable or rejected automated navigation.",
    auth_session: "The run likely requires authentication/session setup or encountered bot/CAPTCHA protection.",
    script_syntax: "The Playwright script has a syntax or TypeScript error before meaningful execution.",
    unknown: "The failure could not be classified with high confidence.",
  };
  return labels[classification];
}

function repairSyntax(sourceSpec: string) {
  return sourceSpec
    .replace(/\baysnc\b/g, "async")
    .replace(/async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>/g, "async ({ page }) =>")
    .replace(/test\(([^,]+),\s*async\(\{page\}\)=>/g, "test($1, async ({ page }) =>");
}

function repairUrlAssertions(sourceSpec: string, failureText: string) {
  const actualUrl = failureText.match(/https?:\/\/[^\s"'<>]+/gi)?.at(-1);
  if (!actualUrl) return sourceSpec;
  return sourceSpec.replace(/await\s+expect\(page\)\.toHaveURL\((["'`])https?:\/\/.+?\1\);/g, `await expect(page).toHaveURL(${JSON.stringify(actualUrl)});`);
}

function repairSelectorText(sourceSpec: string, brokenSelectors: string[], pageContext: PageContext) {
  let fixed = sourceSpec;
  const visible = [...(pageContext.visibleText || []), ...(pageContext.buttons || []).map((item) => item.text || ""), ...(pageContext.links || []).map((item) => item.text || "")].filter(Boolean);

  for (const broken of brokenSelectors) {
    const text = extractSelectorText(broken);
    if (!text) continue;
    const replacement = bestTextMatch(text, visible);
    if (!replacement || replacement === text) continue;
    fixed = fixed
      .replace(new RegExp(escapeRegex(`getByText(${JSON.stringify(text)}`), "g"), `getByText(${JSON.stringify(replacement)}`)
      .replace(new RegExp(escapeRegex(`name: ${JSON.stringify(text)}`), "g"), `name: ${JSON.stringify(replacement)}`);
  }

  return fixed;
}

function repairTimeouts(sourceSpec: string, failureText: string) {
  if (!/navigation|waiting for.*navigation|tohaveurl/i.test(failureText)) return sourceSpec;
  return sourceSpec.replace(/(await\s+page\.[^\n]+\.click\(\);)\n(\s*await\s+expect\(page\)\.toHaveURL)/g, "$1\n  await page.waitForLoadState(\"domcontentloaded\").catch(() => undefined);\n$2");
}

function buildSelectorSuggestions(brokenSelectors: string[], pageContext: PageContext, classification: FailureClassification) {
  const options = [
    ...(pageContext.buttons || []).map((item) => item.text ? `Try button role/text selector for "${item.text}" (${item.selectorHint || "no hint"}).` : ""),
    ...(pageContext.links || []).map((item) => item.text ? `Try link role/text selector for "${item.text}" (${item.selectorHint || "no hint"}).` : ""),
    ...(pageContext.inputs || []).map((item) => `Try input selector from label/placeholder "${item.label || item.placeholder || item.type || "input"}" (${item.selectorHint || "no hint"}).`),
  ].filter(Boolean).slice(0, 8);

  const base = classification === "script_syntax"
    ? ["Repair TypeScript/JavaScript syntax before changing locators."]
    : brokenSelectors.flatMap((selector) => [`Replace or relax broken selector: ${selector}`]).slice(0, 6);

  return unique([...base, ...options]).slice(0, 12);
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

function extractSelectorText(selector: string) {
  return selector.match(/getByText\((["'`])(.+?)\1/)?.[2]
    || selector.match(/name:\s*(["'`])(.+?)\1/)?.[2]
    || selector.match(/getBy(?:Role|Label|Placeholder|TestId)\([^,]+,\s*\{\s*name:\s*(["'`])(.+?)\1/)?.[2]
    || "";
}

function bestTextMatch(target: string, candidates: string[]) {
  const normalizedTarget = normalizeText(target);
  let best = "";
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = similarity(normalizedTarget, normalizeText(candidate));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 0.45 ? best : "";
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const aTokens = new Set(a.split(/\s+/));
  const bTokens = new Set(b.split(/\s+/));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  return overlap / Math.max(aTokens.size, bTokens.size, 1);
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

function summarizeValidationFailure(report: unknown) {
  const row = report && typeof report === "object" ? report as { tests?: Array<{ error?: string }>; stderr?: string; stdout?: string } : {};
  return limit(row.tests?.find((test) => test.error)?.error || row.stderr || row.stdout || "Validation run failed.", 500);
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

function normalizeCandidate(value: Record<string, unknown>, sourceSpec: string, strategy: HealCandidate["strategy"]): HealCandidate {
  return {
    strategy,
    summary: stringField(value.summary, "Healing analysis completed."),
    rootCause: stringField(value.rootCause, "The failure likely comes from a stale selector or changed page behavior."),
    brokenSelectors: stringArray(value.brokenSelectors),
    suggestedChanges: stringArray(value.suggestedChanges),
    fixedSpec: stringField(value.fixedSpec, sourceSpec),
    confidence: Math.max(0, Math.min(0.95, Number(value.confidence ?? 0.7))),
    warnings: stringArray(value.warnings),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || !candidate.trim().startsWith("{")) throw new Error("Healing model returned non-JSON output.");
  return JSON.parse(candidate) as Record<string, unknown>;
}

function getRunnableSpec(files: Record<string, string>) {
  return files["tests/generated.spec.ts"] || files["tests/pasted.spec.ts"] || Object.entries(files)
    .filter(([file]) => file.endsWith(".spec.ts") || file.endsWith(".test.ts"))
    .map(([, content]) => content)
    .join("\n");
}

function ensurePlaywrightImport(content: string) {
  const trimmed = cleanPlaywrightSpecTail(content.trim());
  if (/from\s+["']@playwright\/test["']/.test(trimmed)) return trimmed;
  return `import { test, expect } from "@playwright/test";\n\n${trimmed}`;
}

function cleanPlaywrightSpecTail(value: string) {
  if (!/test\s*\(/.test(value)) return value;
  const warningIndex = value.search(/\n\s*["']?warnings["']?\s*:/i);
  const beforeWarnings = warningIndex >= 0 ? value.slice(0, warningIndex) : value;
  const lastTestClose = Math.max(beforeWarnings.lastIndexOf("\n});"), beforeWarnings.lastIndexOf("});"));
  return lastTestClose >= 0 ? beforeWarnings.slice(0, lastTestClose + 3).trim() : beforeWarnings.trim();
}

function extractArtifacts(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clean(value: string) {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function limit(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
