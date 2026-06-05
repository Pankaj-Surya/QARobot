import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { runnerSettings, testCases, testScripts } from "../db/schema.js";
import { featureMissingModelMessage, generateWithFeatureModel, testFeatureModelConnection, type ChatMessage } from "../services/ai-adapter.js";
import { inspectAppPage, type PageInspectionContext } from "../services/page-inspection.js";

const generationModeSchema = z.enum(["stable_auto", "llm_dom", "llm_only", "deterministic_dom", "deterministic_only"]);

const generateScriptSchema = z
  .object({
    name: z.string().min(1),
    appUrl: z.string().url().refine((value) => /^https?:\/\//i.test(value), "App URL must start with http:// or https://."),
    inputMode: z.enum(["saved", "manual"]).default("saved"),
    generationMode: generationModeSchema.default("llm_dom"),
    framework: z.enum(["playwright"]).optional().default("playwright"),
    testCaseIds: z.array(z.string().uuid()).optional().default([]),
    manualTestCaseText: z.string().optional().default(""),
  })
  .superRefine((value, context) => {
    if (value.inputMode === "saved" && value.testCaseIds.length === 0) {
      context.addIssue({ code: "custom", path: ["testCaseIds"], message: "Select at least one saved test case." });
    }

    if (value.inputMode === "manual" && value.manualTestCaseText.trim().length === 0) {
      context.addIssue({ code: "custom", path: ["manualTestCaseText"], message: "Manual testcase text is required." });
    }
  });

type GenerateScriptConfig = z.infer<typeof generateScriptSchema>;
type ScriptCase = {
  id: string;
  tcId: string;
  title: string;
  module: string;
  testType: string;
  priority: string;
  preconditions: string | null;
  steps: string[];
  testData: string | null;
  expectedResult: string;
};

type GeneratedFilesPayload = {
  files: Record<string, string>;
  warnings?: string[];
};

export async function scriptsRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await db.select().from(testScripts).orderBy(desc(testScripts.createdAt));
    return { scripts: rows };
  });

  app.post("/test-generation-config", async (request, reply) => {
    const parsed = z
      .object({
        appUrl: z.string().url().refine((value) => /^https?:\/\//i.test(value), "App URL must start with http:// or https://."),
        generationMode: generationModeSchema.default("llm_dom"),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid script generation configuration",
        details: parsed.error.flatten(),
      });
    }

    const result = await testGenerationConfig(parsed.data.appUrl, parsed.data.generationMode);
    return reply.send(result);
  });

  app.post("/generate", async (request, reply) => {
    const parsed = generateScriptSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid script generation request",
        details: parsed.error.flatten(),
      });
    }

    const config = parsed.data;
    const stableMode = config.generationMode === "stable_auto";
    const requiresLlm = isLlmMode(config.generationMode);
    const requiresDom = isDomMode(config.generationMode);
    const cases = config.inputMode === "saved" ? await loadSavedCases(config.testCaseIds) : buildManualCases(config.manualTestCaseText);

    if (cases.length === 0) {
      return reply.code(404).send({ error: "No test cases found for script generation." });
    }

    const workerUrl = await loadInspectionWorkerUrl();
    const pageContext = requiresDom || stableMode
      ? await inspectAppPage(config.appUrl, workerUrl)
      : buildUnavailablePageContext(config.appUrl, "DOM inspection was not requested for this generation mode.");
    if (requiresDom && !stableMode && pageContext.mode !== "external_browser") {
      return reply.code(400).send({
        error: `DOM inspection is required for ${generationModeLabel(config.generationMode)}, but the runner inspection worker is not available. Test the generation configuration, start the runner worker, or choose an option without DOM inspection.`,
        pageContext,
      });
    }

    const warnings = [...pageContext.warnings];
    if (stableMode && pageContext.mode !== "external_browser") {
      warnings.push("Live DOM inspection was blocked or unavailable. Script generated from testcase/RAG/manual input instead.");
    }
    let files = buildPlaywrightFiles(cases, config, pageContext, warnings);
    let modelUsed = false;

    if (requiresLlm || stableMode) {
      try {
        const generated = await generateFilesWithModel(cases, config, pageContext);
        files = mergeRequiredFiles(generated.files, cases, config, pageContext, generated.warnings || warnings);
        warnings.push(...(generated.warnings || []));
        modelUsed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scripting model generation failed.";
        if (stableMode) {
          warnings.push(`Scripting model unavailable for Stable Auto Generate; deterministic script was produced instead. ${message}`);
        } else {
        return reply.code(400).send({
          error:
            message === featureMissingModelMessage("test_script_generator")
              ? `${message} This generation mode requires an LLM. Choose a deterministic mode or configure and test the Test Script Generator model.`
              : `Scripting model failed for ${generationModeLabel(config.generationMode)}. ${message}`,
        });
        }
      }
    }

    const validation: { status: "validated" | "partially_validated" | "unvalidated" | "not_requested"; attempts: number; report?: unknown; warning?: string } = stableMode
      ? await validateGeneratedScript(workerUrl, config, files).catch((error) => ({
          status: "unvalidated" as const,
          attempts: 1,
          warning: error instanceof Error ? error.message : "Script validation failed before completion.",
        }))
      : { status: "not_requested" as const, attempts: 0 };

    return reply.code(201).send({
      script: {
        id: `local-${Date.now()}`,
        name: config.name,
        framework: config.framework,
        testCaseIds: config.inputMode === "saved" ? config.testCaseIds : [],
        files,
        appUrl: config.appUrl,
        inputMode: config.inputMode,
        generationMode: config.generationMode,
        generationMeta: {
          label: generationModeLabel(config.generationMode),
          modelRequired: requiresLlm,
          modelUsed,
          domInspectionRequired: requiresDom,
          domInspectionMode: pageContext.mode,
          deterministicUsed: !modelUsed,
          validationStatus: validation.status,
          validationAttempts: validation.attempts,
        },
        manualTestCaseText: config.inputMode === "manual" ? config.manualTestCaseText : null,
        pageContext,
        generationWarnings: unique(validation.warning ? [...warnings, validation.warning] : warnings),
        validation,
        createdAt: new Date().toISOString(),
        storage: "local",
      },
    });
  });
}

async function testGenerationConfig(appUrl: string, generationMode: GenerateScriptConfig["generationMode"]) {
  const requiresLlm = isLlmMode(generationMode);
  const requiresDom = isDomMode(generationMode);
  const model = requiresLlm
    ? await testRequiredModel()
    : { required: false, ok: true, message: "LLM is not required for this mode." };
  const domInspection = requiresDom
    ? await testRequiredDomInspection(appUrl)
    : { required: false, ok: true, mode: "not_requested", message: "DOM inspection is not required for this mode." };

  return {
    ok: (!requiresLlm || model.ok) && (!requiresDom || domInspection.ok),
    generationMode,
    label: generationModeLabel(generationMode),
    model,
    domInspection,
  };
}

async function testRequiredModel() {
  try {
    const result = await testFeatureModelConnection("test_script_generator");
    return {
      required: true,
      ok: true,
      providerName: result.providerName,
      modelName: result.modelName,
      taskType: result.taskType,
      message: result.note,
    };
  } catch (error) {
    return {
      required: true,
      ok: false,
      message: error instanceof Error ? error.message : "Test Script Generator model connection failed.",
    };
  }
}

async function testRequiredDomInspection(appUrl: string) {
  const pageContext = await inspectAppPage(appUrl, await loadInspectionWorkerUrl());
  return {
    required: true,
    ok: pageContext.mode === "external_browser",
    mode: pageContext.mode,
    title: pageContext.title,
    finalUrl: pageContext.finalUrl,
    warnings: pageContext.warnings,
    message:
      pageContext.mode === "external_browser"
        ? `Browser DOM inspection succeeded${pageContext.title ? ` for "${pageContext.title}"` : ""}.`
        : pageContext.warnings.join(" ") || "Browser DOM inspection is unavailable.",
  };
}

function isLlmMode(mode: GenerateScriptConfig["generationMode"]) {
  return mode === "llm_dom" || mode === "llm_only";
}

function isDomMode(mode: GenerateScriptConfig["generationMode"]) {
  return mode === "llm_dom" || mode === "deterministic_dom";
}

function generationModeLabel(mode: GenerateScriptConfig["generationMode"]) {
  const labels: Record<GenerateScriptConfig["generationMode"], string> = {
    stable_auto: "Stable Auto Generate",
    llm_dom: "LLM + DOM inspection",
    llm_only: "LLM only",
    deterministic_dom: "Deterministic fallback + DOM inspection",
    deterministic_only: "Deterministic fallback only",
  };
  return labels[mode];
}

async function validateGeneratedScript(
  workerUrl: string,
  config: GenerateScriptConfig,
  files: Record<string, string>,
): Promise<{ status: "validated" | "partially_validated" | "unvalidated"; attempts: number; report?: unknown; warning?: string }> {
  if (!workerUrl) {
    return {
      status: "unvalidated",
      attempts: 0,
      warning: "Runner worker is not configured, so Stable Auto Generate could not validate this script.",
    };
  }

  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/runner/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: `scriptgen-${Date.now()}`,
      purpose: "healing_validation",
      browser: "chromium",
      headed: false,
      script: {
        name: config.name,
        appUrl: config.appUrl,
        files,
      },
    }),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) as { status?: string; report?: unknown } : {};
  if (!response.ok) {
    return {
      status: "unvalidated",
      attempts: 1,
      report: payload,
      warning: `Runner validation failed with ${response.status}: ${text.slice(0, 500)}`,
    };
  }

  return {
    status: payload.status === "passed" ? "validated" : "partially_validated",
    attempts: 1,
    report: payload.report,
    warning: payload.status === "passed" ? undefined : "Generated script did not fully pass validation. Review runner report before using it.",
  };
}

function buildUnavailablePageContext(appUrl: string, warning: string): PageInspectionContext {
  return {
    mode: "unavailable",
    requestedUrl: appUrl,
    headings: [],
    buttons: [],
    links: [],
    inputs: [],
    visibleText: [],
    warnings: [warning],
  };
}

async function loadInspectionWorkerUrl() {
  const [settings] = await db.select().from(runnerSettings).where(eq(runnerSettings.key, "default")).limit(1);
  return settings?.workerUrl || process.env.PAGE_INSPECTION_WORKER_URL || "";
}

async function loadSavedCases(testCaseIds: string[]): Promise<ScriptCase[]> {
  const rows = await db.select().from(testCases).where(inArray(testCases.id, testCaseIds));
  return rows.map((testCase) => ({
    id: testCase.id,
    tcId: testCase.tcId,
    title: testCase.title,
    module: testCase.module,
    testType: testCase.testType,
    priority: testCase.priority,
    preconditions: testCase.preconditions,
    steps: testCase.steps || [],
    testData: testCase.testData,
    expectedResult: testCase.expectedResult,
  }));
}

function buildManualCases(text: string): ScriptCase[] {
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const sourceBlocks = blocks.length > 0 ? blocks : [text.trim()];

  return sourceBlocks.map((block, index) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = lines.find((line) => !/^(step|expected|data|precondition)/i.test(line)) || `Manual testcase ${index + 1}`;
    const steps = lines.filter((line) => /^(\d+[.)]\s*|step\s*\d*[:.-])/i.test(line)).map((line) => line.replace(/^(\d+[.)]\s*|step\s*\d*[:.-]\s*)/i, ""));
    const expected = lines.find((line) => /^expected/i.test(line))?.replace(/^expected\s*(result)?\s*[:.-]\s*/i, "") || "Behavior matches the manual testcase expectation.";

    return {
      id: `manual-${index + 1}`,
      tcId: `MANUAL-${String(index + 1).padStart(3, "0")}`,
      title,
      module: inferModule(block),
      testType: "Functional",
      priority: "Medium",
      preconditions: lines.find((line) => /^precondition/i.test(line)) || null,
      steps: steps.length > 0 ? steps : lines.slice(1, 6),
      testData: lines.find((line) => /^test data|^data/i.test(line)) || null,
      expectedResult: expected,
    };
  });
}

async function generateFilesWithModel(
  cases: ScriptCase[],
  config: GenerateScriptConfig,
  pageContext: PageInspectionContext,
): Promise<GeneratedFilesPayload> {
  const promptCases = cases.map(compactCaseForPrompt).slice(0, 8);
  const promptPageContext = compactPageContextForPrompt(pageContext);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        'You are a senior Playwright automation engineer. Return only valid JSON with shape {"files":{"tests/generated.spec.ts":"content"},"warnings":["..."]}. Generate one simple Playwright TypeScript spec file only. Do not create page objects, helper classes, fixture files, data files, or README files. Use direct Playwright commands like page.goto, getByRole, getByText, locator, and expect. Keep the style simple like a Playwright codegen recording. Prefer stable role, label, placeholder, text, test id, id, or name selectors from the compact DOM context. Never include explanations outside JSON.',
    },
    {
      role: "user",
      content: `App URL: ${config.appUrl}
Generation mode: ${generationModeLabel(config.generationMode)}

Testcases:
${JSON.stringify(promptCases, null, 2)}

Compact DOM context:
${JSON.stringify(promptPageContext, null, 2)}`,
    },
  ];

  return parseGeneratedFiles(await generateWithFeatureModel("test_script_generator", messages, { maxTokens: 2400 }));
}

function compactCaseForPrompt(testCase: ScriptCase) {
  return {
    id: testCase.tcId,
    title: limitText(testCase.title, 180),
    module: testCase.module,
    preconditions: limitText(testCase.preconditions || "", 240),
    steps: testCase.steps.slice(0, 18).map((step) => limitText(step, 220)),
    testData: limitText(testCase.testData || "", 220),
    expectedResult: limitText(testCase.expectedResult, 260),
  };
}

function compactPageContextForPrompt(pageContext: PageInspectionContext) {
  return {
    mode: pageContext.mode,
    title: limitText(pageContext.title || "", 120),
    finalUrl: pageContext.finalUrl,
    headings: pageContext.headings.map((item) => limitText(item, 100)).slice(0, 12),
    buttons: pageContext.buttons.map((item) => ({ text: limitText(item.text, 80), selectorHint: limitText(item.selectorHint, 120) })).slice(0, 24),
    links: pageContext.links.map((item) => ({ text: limitText(item.text, 80), href: limitText(item.href, 140), selectorHint: limitText(item.selectorHint, 120) })).slice(0, 24),
    inputs: pageContext.inputs.map((item) => ({
      label: limitText(item.label, 80),
      placeholder: limitText(item.placeholder, 80),
      type: item.type,
      selectorHint: limitText(item.selectorHint, 120),
    })).slice(0, 24),
    visibleText: pageContext.visibleText.map((item) => limitText(item, 120)).slice(0, 30),
  };
}

function limitText(value: string, maxLength: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
}

function parseGeneratedFiles(output: string): GeneratedFilesPayload {
  const directCode = extractCodeBlock(output) || (looksLikePlaywrightSpec(output) ? output.trim() : "");
  const jsonText = output.trim().startsWith("{") ? output.trim() : output.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) {
    if (directCode) return { files: { "tests/generated.spec.ts": ensurePlaywrightImport(directCode) }, warnings: [] };
    throw new Error("Scripting model did not return JSON or a Playwright spec.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const recovered = recoverSpecFromBrokenJson(output) || directCode;
    if (recovered) {
      return {
        files: { "tests/generated.spec.ts": ensurePlaywrightImport(recovered) },
        warnings: [],
      };
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    if (directCode) return { files: { "tests/generated.spec.ts": ensurePlaywrightImport(directCode) }, warnings: [] };
    throw new Error("Scripting model JSON must contain a files object.");
  }
  const row = parsed as { files?: unknown; warnings?: unknown };
  if (!row.files || typeof row.files !== "object" || Array.isArray(row.files)) {
    throw new Error("Scripting model files must be an object.");
  }
  return {
    files: Object.fromEntries(Object.entries(row.files).map(([key, value]) => [key, String(value)])),
    warnings: [],
  };
}

function mergeRequiredFiles(
  files: Record<string, string>,
  cases: ScriptCase[],
  config: GenerateScriptConfig,
  pageContext: PageInspectionContext,
  warnings: string[],
) {
  const fallback = buildPlaywrightFiles(cases, config, pageContext, warnings);
  const generatedSpec = files["tests/generated.spec.ts"] || files["generated.spec.ts"] || Object.entries(files).find(([file]) => file.endsWith(".spec.ts"))?.[1];
  return {
    ...fallback,
    ...(generatedSpec ? { "tests/generated.spec.ts": ensurePlaywrightImport(generatedSpec) } : {}),
    "package.json": fallback["package.json"],
    "playwright.config.ts": fallback["playwright.config.ts"],
  };
}

function buildPlaywrightFiles(
  cases: ScriptCase[],
  config: GenerateScriptConfig,
  pageContext: PageInspectionContext,
  warnings: string[],
) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        scripts: {
          test: "playwright test",
          "test:headed": "playwright test --headed",
        },
        devDependencies: {
          "@playwright/test": "^1.44.0",
          typescript: "^5.5.3",
        },
      },
      null,
      2,
    ),
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
    baseURL: process.env.BASE_URL || ${JSON.stringify(config.appUrl)},
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
    "tests/generated.spec.ts": buildSpec(cases, pageContext),
  };

  return files;
}

function buildSpec(cases: ScriptCase[], pageContext: PageInspectionContext) {
  const tests = cases
    .map((testCase) => {
      const stepCalls = testCase.steps
        .map((step) => stepToPlaywright(step, pageContext))
        .join("\n");

      return `test(${JSON.stringify(`${testCase.tcId} ${testCase.title}`)}, async ({ page }) => {
  await page.goto("/");
${stepCalls || "  // TODO: add test actions for this testcase."}
${expectationToPlaywright(testCase.expectedResult)}
});`;
    })
    .join("\n\n");

  return `import { test, expect } from "@playwright/test";

${tests}
`;
}

function stepToPlaywright(step: string, pageContext: PageInspectionContext) {
  const clean = sanitize(step);
  const lower = clean.toLowerCase();
  const quoted = extractQuoted(clean);

  if (/^(launch|open|navigate|go to)\b/.test(lower)) {
    return "  await page.goto(\"/\");";
  }

  if (/verify|redirect|url/.test(lower) && quoted && /^https?:\/\//i.test(quoted)) {
    return `  await expect(page).toHaveURL(${JSON.stringify(quoted)});`;
  }

  if (/header.*logout|logout.*button|logout.*link/.test(lower)) {
    return "  await expect(page.getByRole(\"link\", { name: \"Logout\" })).toBeVisible();";
  }

  if (/click/.test(lower)) {
    const target = normalizeActionTarget(clean.replace(/^click\s+/i, ""));
    return clickTarget(target, pageContext);
  }

  if (/select\s+user(name)?/.test(lower)) {
    const value = quoted || findVisibleText(pageContext, /image_not_loading_user|demouser|fav_user|existing_orders_user/i) || "image_not_loading_user";
    return [
      "  await page.locator(\"div\").filter({ hasText: /^Select Username$/ }).nth(2).click();",
      `  await page.getByText(${JSON.stringify(value)}, { exact: true }).click();`,
    ].join("\n");
  }

  if (/select\s+pass(word)?/.test(lower)) {
    const value = quoted || findVisibleText(pageContext, /testingisfun99|testingisfun|password/i) || "testingisfun99";
    return [
      "  await page.locator(\"div\").filter({ hasText: /^Select Password$/ }).nth(2).click();",
      `  await page.getByText(${JSON.stringify(value)}, { exact: true }).click();`,
    ].join("\n");
  }

  if (/^search\b|search\s+["']?/.test(lower)) {
    const value = quoted || clean.replace(/^search\s+/i, "").trim();
    return [
      "  await page.getByPlaceholder(/search/i).fill(" + JSON.stringify(value) + ");",
      "  await page.keyboard.press(\"Enter\").catch(() => undefined);",
    ].join("\n");
  }

  if (/user should see|should see|verify/.test(lower)) {
    const value = quoted || clean.replace(/^(user\s+)?should see|^verify/i, "").replace(/match/i, "").trim();
    if (value) return `  await expect(page.getByText(/${escapeRegex(value)}/i)).toBeVisible();`;
  }

  return `  // TODO: map this testcase step to a stable selector.\n  console.log("Manual step:", ${JSON.stringify(clean)});`;
}

function expectationToPlaywright(expectedResult: string) {
  const expected = sanitize(expectedResult);
  if (!expected || /behavior matches/i.test(expected)) return "";
  const quoted = extractQuoted(expected);
  if (quoted) return `  await expect(page.getByText(${JSON.stringify(quoted)}, { exact: false })).toBeVisible();`;
  return `  console.log("Expected:", ${JSON.stringify(expected)});`;
}

function clickTarget(target: string, pageContext: PageInspectionContext) {
  const cleanTarget = normalizeActionTarget(target);
  const escaped = escapeRegex(cleanTarget);
  const matchingLink = pageContext.links.find((link) => sameLabel(link.text, cleanTarget));
  const matchingButton = pageContext.buttons.find((button) => sameLabel(button.text, cleanTarget));

  if (matchingLink) return `  await page.getByRole("link", { name: ${JSON.stringify(matchingLink.text || cleanTarget)} }).click();`;
  if (matchingButton || /button$/i.test(cleanTarget)) return `  await page.getByRole("button", { name: /${escaped}/i }).click();`;
  if (/sign in|signin/i.test(cleanTarget)) return "  await page.getByRole(\"link\", { name: \"Sign In\" }).click();";
  if (/log in|login/i.test(cleanTarget)) return "  await page.getByRole(\"button\", { name: \"Log In\" }).click();";
  if (/logout|log out/i.test(cleanTarget)) return "  await page.getByRole(\"link\", { name: \"Logout\" }).click();";
  if (/search product|search/i.test(cleanTarget)) return "  await page.getByPlaceholder(/search/i).click();";
  return `  await page.getByText(${JSON.stringify(cleanTarget)}, { exact: false }).click();`;
}

function normalizeActionTarget(value: string) {
  return value.replace(/\b(button|link|field|input)\b/gi, "").replace(/\s+/g, " ").trim();
}

function sameLabel(a: string, b: string) {
  return normalizeActionTarget(a).toLowerCase() === normalizeActionTarget(b).toLowerCase();
}

function extractQuoted(value: string) {
  return value.match(/["']([^"']+)["']/)?.[1] || "";
}

function findVisibleText(pageContext: PageInspectionContext, pattern: RegExp) {
  return pageContext.visibleText.find((text) => pattern.test(text)) || "";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferModule(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("login") || lower.includes("sign in")) return "Login";
  if (lower.includes("cart")) return "Cart";
  if (lower.includes("checkout")) return "Checkout";
  if (lower.includes("search")) return "Search";
  return "General";
}

function sanitize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function ensurePlaywrightImport(content: string) {
  const trimmed = cleanPlaywrightSpecTail(content.trim());
  if (/from\s+["']@playwright\/test["']/.test(trimmed)) return trimmed;
  return `import { test, expect } from "@playwright/test";\n\n${trimmed}`;
}

function extractCodeBlock(output: string) {
  return output.match(/```(?:ts|typescript|javascript|js)?\s*([\s\S]*?)```/i)?.[1]?.trim() || "";
}

function looksLikePlaywrightSpec(output: string) {
  return /test\s*\(/.test(output) && /page\./.test(output);
}

function recoverSpecFromBrokenJson(output: string) {
  const codeBlock = extractCodeBlock(output);
  if (codeBlock) return cleanPlaywrightSpecTail(codeBlock);

  const importIndex = output.indexOf("import ");
  if (importIndex === -1) return "";

  let spec = output.slice(importIndex);
  spec = spec.replace(/"\s*,?\s*"warnings"[\s\S]*$/i, "").trim();
  spec = spec.replace(/"\s*}\s*}\s*$/i, "").trim();
  spec = spec.replace(/\\"/g, "\"").replace(/\\n/g, "\n");
  spec = cleanPlaywrightSpecTail(spec);
  return looksLikePlaywrightSpec(spec) ? spec : "";
}

function cleanPlaywrightSpecTail(value: string) {
  if (!looksLikePlaywrightSpec(value)) return value;

  const warningIndex = value.search(/\n\s*["']?warnings["']?\s*:/i);
  const beforeWarnings = warningIndex >= 0 ? value.slice(0, warningIndex) : value;
  const lastTestClose = Math.max(beforeWarnings.lastIndexOf("\n});"), beforeWarnings.lastIndexOf("});"));
  if (lastTestClose >= 0) {
    return beforeWarnings.slice(0, lastTestClose + 3).trim();
  }

  return beforeWarnings
    .replace(/\n\s*["']\s*$/g, "")
    .replace(/\n\s*}\s*,?\s*$/g, "")
    .trim();
}
