import cors from "@fastify/cors";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import Fastify from "fastify";
import { chromium } from "playwright";
import { z } from "zod";

loadLocalEnv();

const jobSchema = z.object({
  runId: z.string().min(1),
  callbackBaseUrl: z.string().url().nullable().optional(),
  script: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    framework: z.literal("playwright"),
    appUrl: z.string().url(),
    files: z.record(z.string()),
  }),
  browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  headed: z.boolean().optional().default(false),
});

const inspectSchema = z.object({
  appUrl: z.string().url(),
});

type RunLog = { type: "info" | "pass" | "fail" | "warn" | "done"; message: string; at?: string };
type TestResult = { title: string; status: string; durationMs: number; error?: string };
type PlaywrightExecutionResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type ArtifactItem = { type: "html-report" | "screenshot" | "trace" | "video" | "file"; name: string; path: string; url: string; size: number };

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  ok: true,
  service: "qarobot-runner-worker",
  mode: "playwright",
}));

app.post("/inspect", async (request, reply) => {
  const parsed = inspectSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid inspection request", details: parsed.error.flatten() });
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const page = await context.newPage();
    await gotoForInspection(page, parsed.data.appUrl);
    await page.waitForTimeout(1200);

    const domContext = await evaluateDomContext(page);

    return {
      mode: "external_browser",
      requestedUrl: parsed.data.appUrl,
      ...domContext,
    };
  } catch (error) {
    return {
      mode: "unavailable",
      requestedUrl: parsed.data.appUrl,
      headings: [],
      buttons: [],
      links: [],
      inputs: [],
      visibleText: [],
      warnings: [`External browser inspection failed: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  } finally {
    await browser.close();
  }
});

app.get("/runner/runs/:runId/artifacts", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const runDir = runDirectory(runId);
  if (!existsSync(runDir)) return reply.code(404).send({ error: "Run artifacts not found" });
  return artifactManifest(runId, requestUrlBase(request));
});

app.get("/artifacts/:runId/*", async (request, reply) => {
  const params = request.params as { runId: string; "*": string };
  const runDir = runDirectory(params.runId);
  const target = resolve(runDir, params["*"]);
  if (!target.startsWith(runDir) || !existsSync(target) || statSync(target).isDirectory()) {
    return reply.code(404).send({ error: "Artifact not found" });
  }
  reply.header("content-type", contentType(target));
  return reply.send(createReadStream(target));
});

app.post("/runner/jobs", async (request, reply) => {
  const parsed = jobSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid runner job", details: parsed.error.flatten() });
  }

  const job = parsed.data;
  const jobId = `${job.runId}-${Date.now()}`;

  void runJob(job, jobId).catch((error) => {
    app.log.error({ error, runId: job.runId }, "Runner job failed before completion callback");
  });

  return reply.code(202).send({ jobId });
});

type DomInspectionContext = {
  title: string;
  finalUrl: string;
  headings: string[];
  buttons: Array<{ text: string; selectorHint: string }>;
  links: Array<{ text: string; href: string; selectorHint: string }>;
  inputs: Array<{ label: string; placeholder: string; type: string; selectorHint: string }>;
  visibleText: string[];
  warnings: string[];
};

async function gotoForInspection(
  page: { goto: (url: string, options: { waitUntil: "domcontentloaded" | "load"; timeout: number }) => Promise<unknown> },
  appUrl: string,
) {
  const attempts: Array<{ waitUntil: "domcontentloaded" | "load"; timeout: number }> = [
    { waitUntil: "domcontentloaded", timeout: 30_000 },
    { waitUntil: "load", timeout: 45_000 },
  ];
  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return await page.goto(appUrl, attempt);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Navigation failed.";
  if (/ERR_HTTP2_PROTOCOL_ERROR|ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION_RESET|ERR_TIMED_OUT/i.test(message)) {
    throw new Error(
      `${message} This site rejected or interrupted automated Chromium navigation during DOM inspection. Try LLM only mode, deterministic only mode, or inspect a staging/dev URL that allows automation.`,
    );
  }

  throw lastError instanceof Error ? lastError : new Error(message);
}

async function evaluateDomContext(page: { evaluate: (expression: string) => Promise<unknown> }): Promise<DomInspectionContext> {
  return await page.evaluate(`(() => {
    const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const root = document.body || document.documentElement;
    const selectorHint = (element) => {
      const id = element.getAttribute("id");
      const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
      const name = element.getAttribute("name");
      if (testId) return "[data-testid=\\"" + testId.replace(/"/g, "\\\\\\"") + "\\"]";
      if (id) return "#" + id;
      if (name) return element.tagName.toLowerCase() + "[name=\\"" + name.replace(/"/g, "\\\\\\"") + "\\"]";
      return element.tagName.toLowerCase();
    };
    const unique = (values) => Array.from(new Set(values.filter(Boolean)));
    const elementText = (element) => clean(element.value || element.innerText || element.textContent);

    return {
      title: document.title,
      finalUrl: location.href,
      headings: unique(Array.from(document.querySelectorAll("h1,h2,h3")).map((element) => clean(element.textContent))).slice(0, 40),
      buttons: Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).map((element) => ({
        text: elementText(element),
        selectorHint: selectorHint(element),
      })).filter((item) => item.text).slice(0, 80),
      links: Array.from(document.querySelectorAll("a")).map((element) => ({
        text: clean(element.textContent),
        href: element.href || "",
        selectorHint: selectorHint(element),
      })).filter((item) => item.text || item.href).slice(0, 80),
      inputs: Array.from(document.querySelectorAll("input,textarea,select")).map((element) => ({
        label: clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("id")),
        placeholder: clean(element.getAttribute("placeholder")),
        type: clean(element.getAttribute("type") || element.tagName.toLowerCase()),
        selectorHint: selectorHint(element),
      })).slice(0, 80),
      visibleText: root ? unique(Array.from(root.querySelectorAll("a,button,label,input,textarea,select,[role='button'],[role='option'],li,span,div"))
        .map(elementText)
        .filter((text) => text && text.length <= 120))
        .slice(0, 120) : [],
      warnings: [],
    };
  })()`) as DomInspectionContext;
}

const port = Number(process.env.PORT || 4001);
const host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });

async function runJob(job: z.infer<typeof jobSchema>, jobId: string) {
  const callbackBaseUrl = job.callbackBaseUrl || process.env.QA_ROBOT_CALLBACK_BASE_URL;
  const started = Date.now();
  const runDir = prepareRunDir(job.runId, job.script.files);

  await postLog(callbackBaseUrl, job.runId, {
    type: "info",
    message: `Worker ${jobId} started ${job.script.name} on ${job.browser}${job.headed ? " in headed mode" : ""}.`,
  });

  try {
    const result = await executePlaywright(runDir, job.script.appUrl, job.browser, job.headed, callbackBaseUrl, job.runId);
    const durationMs = Date.now() - started;
    const artifacts = artifactManifest(job.runId, publicBaseUrl()).artifacts;
    const report = {
      ...readPlaywrightReport(runDir, result.stdout, result.stderr, durationMs, job.browser, job.headed, job.script.name, job.script.appUrl),
      artifacts,
    };
    const finalStatus = result.exitCode === 0 && report.failed === 0 ? "passed" : "failed";

    await postComplete(callbackBaseUrl, job.runId, {
      status: finalStatus,
      logs: [
        {
          type: finalStatus === "passed" ? "done" : "fail",
          message: result.timedOut ? "Playwright run timed out and was stopped." : `Playwright finished with exit code ${result.exitCode}.`,
        },
      ],
      report,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner worker failed while executing Playwright.";
    await postComplete(callbackBaseUrl, job.runId, {
      status: "failed",
      logs: [{ type: "fail", message }],
      report: {
        ...makeFailureReport(job.script.name, job.script.appUrl, job.browser, job.headed, Date.now() - started, message),
        artifacts: artifactManifest(job.runId, publicBaseUrl()).artifacts,
      },
    });
  }
}

function prepareRunDir(runId: string, files: Record<string, string>) {
  const runDir = runDirectory(runId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const target = resolve(runDir, relativePath);
    if (!target.startsWith(runDir)) {
      throw new Error(`Refusing to write file outside run directory: ${relativePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  linkWorkerNodeModules(runDir);

  return runDir;
}

async function executePlaywright(
  runDir: string,
  appUrl: string,
  browser: string,
  headed: boolean,
  callbackBaseUrl: string | undefined,
  runId: string,
) {
  const cliPath = resolve(process.cwd(), "node_modules", "playwright", "cli.js");
  const command = existsSync(cliPath) ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
  const args = existsSync(cliPath)
    ? [cliPath, "test", `--project=${browser}`]
    : ["playwright", "test", `--project=${browser}`];
  if (headed) args.push("--headed");
  const timeoutMs = Number(process.env.RUNNER_TIMEOUT_MS || 120_000);
  const commandLine = `${command} ${args.join(" ")}`;

  await postLog(callbackBaseUrl, runId, {
    type: "info",
    message: `Launching Playwright: ${commandLine}`,
  });

  return new Promise<PlaywrightExecutionResult>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: runDir,
      env: {
        ...process.env,
        BASE_URL: appUrl,
        NODE_PATH: join(process.cwd(), "node_modules"),
      },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = `Playwright did not finish within ${Math.round(timeoutMs / 1000)} seconds. Stopping the run.`;
      stderr += `\n${message}`;
      void postLog(callbackBaseUrl, runId, { type: "fail", message });
      child.kill("SIGTERM");
      resolvePromise({ exitCode: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      void postLog(callbackBaseUrl, runId, { type: "info", message: trimLog(text) });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      void postLog(callbackBaseUrl, runId, { type: "warn", message: trimLog(text) });
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const message = `Failed to start Playwright process: ${error.message}`;
      stderr += message;
      void postLog(callbackBaseUrl, runId, { type: "fail", message });
      resolvePromise({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function linkWorkerNodeModules(runDir: string) {
  const workerNodeModules = resolve(process.cwd(), "node_modules");
  const targetNodeModules = join(runDir, "node_modules");
  if (!existsSync(workerNodeModules) || existsSync(targetNodeModules)) return;
  try {
    symlinkSync(workerNodeModules, targetNodeModules, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // If linking is not allowed, Playwright may still work through NODE_PATH.
  }
}

function runDirectory(runId: string) {
  const workRoot = resolve(process.cwd(), process.env.RUNNER_WORK_DIR || ".runner-work");
  return join(workRoot, "runs", safeName(runId));
}

function artifactManifest(runId: string, baseUrl: string) {
  const runDir = runDirectory(runId);
  const artifacts: ArtifactItem[] = [];
  const htmlReport = join(runDir, "playwright-report", "index.html");
  if (existsSync(htmlReport)) artifacts.push(artifactItem("html-report", runDir, htmlReport, baseUrl, runId));
  for (const file of walkFiles(runDir)) {
    const extension = extname(file).toLowerCase();
    if (file === htmlReport) continue;
    if ([".png", ".jpg", ".jpeg"].includes(extension)) artifacts.push(artifactItem("screenshot", runDir, file, baseUrl, runId));
    else if (extension === ".zip" && /trace/i.test(file)) artifacts.push(artifactItem("trace", runDir, file, baseUrl, runId));
    else if ([".webm", ".mp4"].includes(extension)) artifacts.push(artifactItem("video", runDir, file, baseUrl, runId));
  }
  return { runId, artifacts };
}

function artifactItem(type: ArtifactItem["type"], runDir: string, file: string, baseUrl: string, runId: string): ArtifactItem {
  const artifactPath = relative(runDir, file).replace(/\\/g, "/");
  return {
    type,
    name: artifactPath.split("/").pop() || artifactPath,
    path: artifactPath,
    url: `${baseUrl.replace(/\/$/, "")}/artifacts/${encodeURIComponent(runId)}/${artifactPath.split("/").map(encodeURIComponent).join("/")}`,
    size: statSync(file).size,
  };
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function requestUrlBase(request: { protocol?: string; hostname?: string; headers: Record<string, unknown> }) {
  const proto = String(request.headers["x-forwarded-proto"] || request.protocol || "http");
  const host = String(request.headers.host || request.hostname || `localhost:${port}`);
  return `${proto}://${host}`;
}

function publicBaseUrl() {
  return process.env.RUNNER_PUBLIC_URL || `http://localhost:${port}`;
}

function contentType(file: string) {
  const extension = extname(file).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".zip") return "application/zip";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

function makeFailureReport(scriptName: string, appUrl: string, browser: string, headed: boolean, durationMs: number, message: string) {
  return {
    mode: "worker",
    scriptName,
    appUrl,
    browser,
    headed,
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    durationMs,
    tests: [{ title: "Runner worker", status: "failed", durationMs, error: message }],
    stdout: "",
    stderr: message,
  };
}

function readPlaywrightReport(
  runDir: string,
  stdout: string,
  stderr: string,
  fallbackDurationMs: number,
  browser: string,
  headed: boolean,
  scriptName: string,
  appUrl: string,
) {
  const reportPath = join(runDir, "test-results", "results.json");
  const raw = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) as PlaywrightJsonReport : parseJsonReportFromStdout(stdout);
  if (!raw) {
    return {
      mode: "worker",
      scriptName,
      appUrl,
      browser,
      headed,
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: fallbackDurationMs,
      tests: [{ title: "Playwright execution", status: "failed", durationMs: fallbackDurationMs, error: stderr || stdout || "No JSON report was created." }],
      stdout: trimLong(stdout),
      stderr: trimLong(stderr),
    };
  }

  const tests = flattenSuites(raw.suites || []);
  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.filter((test) => test.status === "failed" || test.status === "timedOut" || test.status === "interrupted").length;
  const skipped = tests.filter((test) => test.status === "skipped").length;

  return {
    mode: "worker",
    scriptName,
    appUrl,
    browser,
    headed,
    total: tests.length,
    passed,
    failed,
    skipped,
    durationMs: Number(raw.stats?.duration || fallbackDurationMs),
    tests,
    stdout: trimLong(stdout),
    stderr: trimLong(stderr),
  };
}

function parseJsonReportFromStdout(stdout: string): PlaywrightJsonReport | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = stdout.slice(start, end + 1)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .trim();

  try {
    const parsed = JSON.parse(candidate) as PlaywrightJsonReport;
    return parsed && Array.isArray(parsed.suites) ? parsed : null;
  } catch {
    return null;
  }
}

function flattenSuites(suites: PlaywrightSuite[], parentTitle = ""): TestResult[] {
  return suites.flatMap((suite) => {
    const suiteTitle = [parentTitle, suite.title].filter(Boolean).join(" > ");
    const specs = (suite.specs || []).flatMap((spec) =>
      (spec.tests || []).map((test) => {
        const result = test.results?.[test.results.length - 1];
        return {
          title: [suiteTitle, spec.title].filter(Boolean).join(" > "),
          status: result?.status || "unknown",
          durationMs: Number(result?.duration || 0),
          error: result?.error?.message || result?.errors?.map((error) => error.message).filter(Boolean).join("\n") || undefined,
        };
      }),
    );
    return [...specs, ...flattenSuites(suite.suites || [], suiteTitle)];
  });
}

async function postLog(callbackBaseUrl: string | undefined, runId: string, entry: RunLog) {
  if (!callbackBaseUrl) return;
  await fetch(`${callbackBaseUrl.replace(/\/$/, "")}/api/runs/${runId}/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...entry, at: entry.at || new Date().toISOString() }),
  }).catch(() => undefined);
}

async function postComplete(callbackBaseUrl: string | undefined, runId: string, body: unknown) {
  if (!callbackBaseUrl) return;
  await fetch(`${callbackBaseUrl.replace(/\/$/, "")}/api/runs/${runId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function trimLog(value: string) {
  return trimLong(value).trim() || "(empty output)";
}

function trimLong(value: string, max = 8000) {
  return value.length > max ? `${value.slice(0, max)}\n... output truncated ...` : value;
}

function loadLocalEnv(fileName = ".env") {
  const envPath = resolve(process.cwd(), fileName);
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

type PlaywrightJsonReport = {
  stats?: { duration?: number };
  suites?: PlaywrightSuite[];
};

type PlaywrightSuite = {
  title: string;
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title: string;
    tests?: Array<{
      results?: Array<{
        status?: string;
        duration?: number;
        error?: { message?: string };
        errors?: Array<{ message?: string }>;
      }>;
    }>;
  }>;
};
