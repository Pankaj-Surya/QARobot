import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { runnerSettings, testRuns, testScripts } from "../db/schema.js";

const runStartSchema = z.object({
  source: z.enum(["saved", "inline"]).optional().default("saved"),
  scriptId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  appUrl: z.string().url().optional(),
  scriptText: z.string().optional(),
  browser: z.enum(["chromium", "firefox", "webkit"]).optional().default("chromium"),
  headed: z.boolean().optional().default(false),
}).superRefine((value, context) => {
  if (value.source === "saved" && !value.scriptId) {
    context.addIssue({ code: "custom", path: ["scriptId"], message: "Select a saved script." });
  }

  if (value.source === "inline") {
    if (!value.name?.trim()) context.addIssue({ code: "custom", path: ["name"], message: "Script name is required." });
    if (!value.appUrl?.trim()) context.addIssue({ code: "custom", path: ["appUrl"], message: "App URL is required." });
    if (!value.scriptText?.trim()) context.addIssue({ code: "custom", path: ["scriptText"], message: "Paste a Playwright script before running." });
  }
});

const runLogSchema = z.object({
  type: z.enum(["info", "pass", "fail", "warn", "done"]).default("info"),
  message: z.string().min(1),
  at: z.string().optional(),
});

const runCompleteSchema = z.object({
  status: z.enum(["passed", "failed", "cancelled"]),
  report: z.record(z.unknown()).optional().default({}),
  logs: z.array(runLogSchema).optional().default([]),
});

const runnerSettingsSchema = z.object({
  mode: z.enum(["disabled", "worker"]).default("disabled"),
  workerUrl: z.string().url().optional().or(z.literal("")),
  callbackBaseUrl: z.string().url().optional().or(z.literal("")),
});

type RunLog = z.infer<typeof runLogSchema>;
type RunResults = {
  mode: "worker";
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  scriptName: string;
  appUrl: string | null;
  browser: string;
  headed: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tests: Array<{ title: string; status: string; durationMs: number; error?: string }>;
  logs: RunLog[];
  workerJobId?: string;
  workerError?: string;
  artifacts?: unknown;
  sourceSpec?: string;
};
type RunnableScript = {
  id: string | null;
  name: string;
  framework: string;
  appUrl: string | null;
  files: Record<string, string>;
};

export async function runsRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await db.select().from(testRuns).orderBy(desc(testRuns.startedAt));
    return { runs: rows };
  });

  app.get("/config", async () => {
    const settings = await loadRunnerSettings();
    return {
      mode: settings.mode,
      workerConfigured: isWorkerConfigured(settings),
      workerUrlSet: Boolean(settings.workerUrl),
      workerUrl: settings.workerUrl,
      callbackBaseUrl: settings.callbackBaseUrl,
      requiredBackendEnv: {
        RUNNER_MODE: "worker",
        RUNNER_WORKER_URL: "http://localhost:4001",
        PUBLIC_BACKEND_URL: "http://localhost:3001",
      },
      supportedOptions: [
        {
          key: "local",
          label: "Local Machine Runner",
          description: "Run the separate QA Robot runner worker on your laptop or desktop and point RUNNER_WORKER_URL to it.",
        },
        {
          key: "cloud",
          label: "Cloud/VM Worker",
          description: "Deploy the same runner worker to a VM, Railway, Render, or Fly.io for Vercel-safe production execution.",
        },
      ],
      message: isWorkerConfigured(settings)
        ? "Runner worker is configured."
        : "Runner worker is not configured. Save and test a local or cloud/VM worker connection from this page.",
    };
  });

  app.put("/settings", async (request, reply) => {
    const parsed = runnerSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid runner settings", details: parsed.error.flatten() });
    }

    const [settings] = await db
      .insert(runnerSettings)
      .values({
        key: "default",
        mode: parsed.data.mode,
        workerUrl: parsed.data.workerUrl || null,
        callbackBaseUrl: parsed.data.callbackBaseUrl || null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: runnerSettings.key,
        set: {
          mode: parsed.data.mode,
          workerUrl: parsed.data.workerUrl || null,
          callbackBaseUrl: parsed.data.callbackBaseUrl || null,
          updatedAt: new Date(),
        },
      })
      .returning();

    return { settings, config: await buildRunnerConfig() };
  });

  app.post("/test-connection", async (request, reply) => {
    const parsed = z.object({ workerUrl: z.string().url() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Worker URL is required.", details: parsed.error.flatten() });
    }

    try {
      const response = await fetch(`${parsed.data.workerUrl.replace(/\/$/, "")}/health`, { method: "GET" });
      const text = await response.text();
      if (!response.ok) {
        return reply.code(502).send({ ok: false, error: `Worker health returned ${response.status}: ${text}` });
      }
      return { ok: true, workerUrl: parsed.data.workerUrl, health: text ? JSON.parse(text) : {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker connection failed.";
      return reply.code(502).send({ ok: false, error: message });
    }
  });

  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Run not found" });
    return { run: row, logs: getLogs(row.results) };
  });

  app.get("/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const settings = await loadRunnerSettings();
    if (!settings.workerUrl) return reply.code(400).send({ error: "Runner worker is not configured." });
    try {
      const response = await fetch(`${settings.workerUrl.replace(/\/$/, "")}/runner/runs/${encodeURIComponent(id)}/artifacts`);
      const text = await response.text();
      if (!response.ok) return reply.code(response.status).send(text ? JSON.parse(text) : { error: "Artifact lookup failed" });
      return text ? JSON.parse(text) : { runId: id, artifacts: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Artifact lookup failed.";
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/start", async (request, reply) => {
    const parsed = runStartSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid run start request",
        details: parsed.error.flatten(),
      });
    }

    const settings = await loadRunnerSettings();
    if (!isWorkerConfigured(settings)) {
      return reply.code(400).send({
        error: "Runner worker is not configured. Save and test a local or cloud/VM worker connection from the Runner page.",
      });
    }

    const { browser, headed } = parsed.data;
    const script = parsed.data.source === "inline"
      ? await createInlineScript(parsed.data)
      : await loadSavedScript(parsed.data.scriptId!);

    if (!script) {
      return reply.code(404).send({ error: "Script not found" });
    }

    if (!script.appUrl) {
      return reply.code(400).send({ error: "This script has no app URL. Regenerate it with an app URL before running." });
    }

    const totalTests = countTests(script.files);
    const initialResults = makeInitialResults(script.name, script.appUrl, browser, headed, totalTests, getRunnableSpec(script.files), [
      log("info", `Queued ${script.name} against ${script.appUrl} on ${browser}${headed ? " in headed mode" : ""}.`),
      log("info", `Discovered ${totalTests} generated test${totalTests === 1 ? "" : "s"}.`),
    ]);
    const [run] = await db
      .insert(testRuns)
      .values({
        scriptId: script.id,
        browser,
        status: "queued",
        startedAt: new Date(),
        totalTests,
        results: initialResults,
      })
      .returning();

    try {
      const workerJobId = await dispatchWorkerJob(run.id, script, browser, headed, settings);
      const updatedResults = {
        ...initialResults,
        workerJobId,
        logs: [...initialResults.logs, log("info", `Worker accepted job${workerJobId ? ` ${workerJobId}` : ""}.`)],
      };
      const [updated] = await db
        .update(testRuns)
        .set({ results: updatedResults })
        .where(eq(testRuns.id, run.id))
        .returning();
      return reply.code(201).send({ run: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker dispatch failed.";
      const failedResults: RunResults = {
        ...initialResults,
        status: "failed",
        failed: Math.max(1, totalTests),
        workerError: message,
        logs: [...initialResults.logs, log("fail", message)],
        tests: [{ title: "Worker dispatch", status: "failed", durationMs: 0, error: message }],
      };
      const [failed] = await db
        .update(testRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          failedCount: failedResults.failed,
          results: failedResults,
        })
        .where(eq(testRuns.id, run.id))
        .returning();
      return reply.code(502).send({ error: message, run: failed });
    }
  });

  app.post("/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = runLogSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid run log", details: parsed.error.flatten() });
    const updated = await appendPersistedLog(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "Run not found" });
    return { run: updated };
  });

  app.post("/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = runCompleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid run completion", details: parsed.error.flatten() });

    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Run not found" });

    const current = normalizeResults(row.results);
    const report = parsed.data.report;
    const total = numberField(report.total, current.total);
    const passed = numberField(report.passed, 0);
    const failed = numberField(report.failed, parsed.data.status === "failed" ? Math.max(1, total - passed) : 0);
    const skipped = numberField(report.skipped, 0);
    const results: RunResults = {
      ...current,
      ...report,
      mode: "worker",
      status: parsed.data.status,
      headed: Boolean(report.headed ?? current.headed),
      total,
      passed,
      failed,
      skipped,
      durationMs: numberField(report.durationMs, current.durationMs),
      tests: Array.isArray(report.tests) ? report.tests as RunResults["tests"] : current.tests,
      logs: [...current.logs, ...parsed.data.logs, log(parsed.data.status === "passed" ? "done" : "fail", `Worker completed run as ${parsed.data.status}.`)],
    };

    const [updated] = await db
      .update(testRuns)
      .set({
        status: parsed.data.status,
        completedAt: new Date(),
        totalTests: total,
        passedCount: passed,
        failedCount: failed,
        results,
      })
      .where(eq(testRuns.id, id))
      .returning();

    return { run: updated };
  });

  app.get("/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const origin = request.headers.origin;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": origin || process.env.FRONTEND_ORIGIN || "http://localhost:3000",
      "access-control-allow-credentials": "true",
      vary: "origin",
    });

    let sent = 0;
    const interval = setInterval(async () => {
      const [row] = await db.select().from(testRuns).where(eq(testRuns.id, id)).limit(1);
      const logs = row ? getLogs(row.results) : [];
      for (const entry of logs.slice(sent)) {
        reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      sent = logs.length;

      if (!row || ["passed", "failed", "cancelled"].includes(row.status)) {
        clearInterval(interval);
        reply.raw.end();
      }
    }, 1000);

    request.raw.on("close", () => clearInterval(interval));
  });
}

async function loadSavedScript(scriptId: string) {
  const [script] = await db.select().from(testScripts).where(eq(testScripts.id, scriptId)).limit(1);
  return script || null;
}

async function createInlineScript(input: z.infer<typeof runStartSchema>) {
  const name = input.name?.trim() || `Pasted script ${new Date().toISOString()}`;
  const appUrl = input.appUrl?.trim() || "";
  const files = buildInlineScriptFiles(name, appUrl, input.scriptText || "");
  return {
    id: null,
    name,
    framework: "playwright",
    appUrl,
    files,
  } satisfies RunnableScript;
}

async function dispatchWorkerJob(runId: string, script: RunnableScript, browser: string, headed: boolean, settings: RunnerConnectionSettings) {
  const workerUrl = settings.workerUrl;
  if (!workerUrl) throw new Error("RUNNER_WORKER_URL is not configured.");

  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/runner/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      callbackBaseUrl: settings.callbackBaseUrl || null,
        script: {
        id: script.id || runId,
        name: script.name,
        framework: script.framework,
        appUrl: script.appUrl,
        files: script.files,
      },
      browser,
      headed,
    }),
  });

  if (!response.ok) {
    throw new Error(`Runner worker returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json().catch(() => ({})) as { jobId?: string };
  return body.jobId || "";
}

async function appendPersistedLog(runId: string, entry: RunLog) {
  const [row] = await db.select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
  if (!row) return null;
  const current = normalizeResults(row.results);
  const [updated] = await db
    .update(testRuns)
    .set({
      status: row.status === "queued" ? "running" : row.status,
      results: {
        ...current,
        status: row.status === "queued" ? "running" : current.status,
        logs: [...current.logs, { ...entry, at: entry.at || new Date().toISOString() }],
      },
    })
    .where(eq(testRuns.id, runId))
    .returning();
  return updated;
}

function makeInitialResults(scriptName: string, appUrl: string | null, browser: string, headed: boolean, total: number, sourceSpec: string, logs: RunLog[]): RunResults {
  return {
    mode: "worker",
    status: "queued",
    scriptName,
    appUrl,
    browser,
    headed,
    total,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    tests: [],
    logs,
    sourceSpec,
  };
}

function normalizeResults(value: unknown): RunResults {
  const row = value && typeof value === "object" ? value as Partial<RunResults> : {};
  return {
    mode: "worker",
    status: row.status || "queued",
    scriptName: row.scriptName || "Unknown script",
    appUrl: row.appUrl || null,
    browser: row.browser || "chromium",
    headed: Boolean(row.headed),
    total: Number(row.total || 0),
    passed: Number(row.passed || 0),
    failed: Number(row.failed || 0),
    skipped: Number(row.skipped || 0),
    durationMs: Number(row.durationMs || 0),
    tests: Array.isArray(row.tests) ? row.tests : [],
    logs: Array.isArray(row.logs) ? row.logs : [],
    workerJobId: row.workerJobId,
    workerError: row.workerError,
    artifacts: row.artifacts,
    sourceSpec: typeof row.sourceSpec === "string" ? row.sourceSpec : undefined,
  };
}

function getLogs(value: unknown) {
  return normalizeResults(value).logs;
}

async function buildRunnerConfig() {
  const settings = await loadRunnerSettings();
  return {
    mode: settings.mode,
    workerConfigured: isWorkerConfigured(settings),
    workerUrlSet: Boolean(settings.workerUrl),
    workerUrl: settings.workerUrl,
    callbackBaseUrl: settings.callbackBaseUrl,
  };
}

type RunnerConnectionSettings = {
  mode: string;
  workerUrl: string;
  callbackBaseUrl: string;
};

async function loadRunnerSettings(): Promise<RunnerConnectionSettings> {
  const [row] = await db.select().from(runnerSettings).where(eq(runnerSettings.key, "default")).limit(1);
  return {
    mode: row?.mode || process.env.RUNNER_MODE || "disabled",
    workerUrl: row?.workerUrl || process.env.RUNNER_WORKER_URL || "",
    callbackBaseUrl: row?.callbackBaseUrl || process.env.PUBLIC_BACKEND_URL || process.env.API_BASE_URL || "",
  };
}

function isWorkerConfigured(settings: RunnerConnectionSettings) {
  return settings.mode === "worker" && Boolean(settings.workerUrl);
}

function countTests(files: Record<string, string>) {
  const spec = getRunnableSpec(files);
  return Math.max((spec.match(/\btest\s*\(/g) || []).length, 1);
}

function getRunnableSpec(files: Record<string, string>) {
  return files["tests/generated.spec.ts"] || files["tests/pasted.spec.ts"] || Object.entries(files)
    .filter(([file]) => file.endsWith(".spec.ts") || file.endsWith(".test.ts"))
    .map(([, content]) => content)
    .join("\n");
}

function buildInlineScriptFiles(name: string, appUrl: string, scriptText: string) {
  return {
    "package.json": JSON.stringify(
      {
        scripts: { test: "playwright test" },
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
    "tests/pasted.spec.ts": normalizePastedScript(scriptText),
    "README.md": `# ${name}

This script was pasted directly in the QA Robot Test Runner.

App URL: ${appUrl}
`,
  };
}

function normalizePastedScript(scriptText: string) {
  const trimmed = cleanPlaywrightSpecTail(extractRunnableSpecText(scriptText.trim()));
  if (/from\s+["']@playwright\/test["']/.test(trimmed)) return trimmed;
  return `import { expect, test } from "@playwright/test";

${trimmed}
`;
}

function extractRunnableSpecText(value: string) {
  const codeBlock = value.match(/```(?:ts|typescript|javascript|js)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (codeBlock && looksLikePlaywrightSpec(codeBlock)) return codeBlock;

  const jsonBlock = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const jsonCandidate = jsonBlock || value.replace(/^json\s*/i, "").trim();
  const parsedSpec = extractSpecFromJson(jsonCandidate);
  if (parsedSpec) return parsedSpec;

  const importIndex = value.indexOf("import ");
  if (importIndex >= 0) {
    const candidate = cleanPlaywrightSpecTail(value.slice(importIndex).replace(/\\"/g, "\"").replace(/\\n/g, "\n").trim());
    if (looksLikePlaywrightSpec(candidate)) return candidate;
  }

  return value;
}

function extractSpecFromJson(value: string) {
  try {
    const parsed = JSON.parse(value) as { files?: Record<string, unknown> };
    if (!parsed.files || typeof parsed.files !== "object") return "";
    const spec = parsed.files["tests/generated.spec.ts"] || parsed.files["tests/pasted.spec.ts"] || Object.entries(parsed.files).find(([file]) => file.endsWith(".spec.ts"))?.[1];
    return typeof spec === "string" ? spec : "";
  } catch {
    return "";
  }
}

function looksLikePlaywrightSpec(value: string) {
  return /test\s*\(/.test(value) && /page\./.test(value);
}

function cleanPlaywrightSpecTail(value: string) {
  const normalized = value
    .replace(/^\s*json\s*/i, "")
    .replace(/^\s*["']?\s*files\s*["']?\s*:\s*/i, "")
    .trim();

  if (!looksLikePlaywrightSpec(normalized)) return normalized;

  const warningIndex = normalized.search(/\n\s*["']?warnings["']?\s*:/i);
  const beforeWarnings = warningIndex >= 0 ? normalized.slice(0, warningIndex) : normalized;
  const lastTestClose = Math.max(beforeWarnings.lastIndexOf("\n});"), beforeWarnings.lastIndexOf("});"));
  if (lastTestClose >= 0) {
    return beforeWarnings.slice(0, lastTestClose + 3).trim();
  }

  return beforeWarnings
    .replace(/\n\s*["']\s*$/g, "")
    .replace(/\n\s*}\s*,?\s*$/g, "")
    .trim();
}

function log(type: RunLog["type"], message: string): RunLog {
  return { type, message, at: new Date().toISOString() };
}

function numberField(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
