# Advanced RAG Upgrade Plan

## Summary
Replace the current keyword-only RAG with a local free advanced RAG pipeline and make chat, test plan, and test case generation depend on retrieved evidence plus the selected active LLM. The feature description/user question remains the source requirement; retrieved chunks become evidence/context, not copied output.

## Key Changes

### RAG Indexing
- Replace coarse word/line chunks with semantic-aware chunks:
  - CSV/testcase files: one row = one atomic chunk, preserving columns as structured metadata.
  - Gherkin files: one scenario/background block = one chunk.
  - Markdown/text/PDF: split by headings/paragraphs first, then token-size windows only when sections are too large.
- Add chunk metadata fields through a Drizzle migration:
  - `chunk_kind`, `source_locator`, `metadata`, `embedding_model`, `token_count`.
- Use local free embeddings with `@xenova/transformers`:
  - embedding model: `Xenova/all-MiniLM-L6-v2`
  - vector size: `384`
  - Upstash Vector index must use cosine similarity and 384 dimensions.
- During document processing:
  - extract structured chunks
  - embed each chunk locally
  - store full chunk in Postgres
  - upsert vector to Upstash with metadata: document id, document name, chunk index, chunk kind, source locator, tags/module if available.

### Advanced Retrieval
- Replace `local_top_k_keyword_index` with hybrid retrieval:
  - lexical candidate search from Postgres using normalized query terms
  - semantic candidate search from Upstash Vector using local query embedding
  - merge candidates using Reciprocal Rank Fusion
  - rerank top 20 candidates with local reranker model `Xenova/ms-marco-MiniLM-L-6-v2`
  - return final top 6 evidence chunks by default.
- Add retrieval guardrails:
  - if top rerank score is below threshold, return “No related data is available” for chat and block unsupported generation.
  - no fallback to unrelated recent chunks.
  - always include retrieved evidence internally, but hide metadata from normal user output.
- Add a debug toggle/API flag for inspection:
  - normal UI: polished answer only
  - debug mode: scores, rerank scores, chunk source, and matched evidence.

### Selected LLM Integration
- Implement `ai-adapter.ts` so chat, test plan, and test case routes require an active model config:
  - `planning` for test plans
  - `generation` for document chat and test cases
- Initial provider support:
  - OpenAI-compatible providers: OpenAI, Groq, Ollama
  - keep Anthropic/Google config stored but return “provider not wired yet” until their adapters are added.
- Prompt pattern:
  - system: strict QA expert, answer only from evidence, no metadata unless debug requested
  - user: original requirement/question
  - context: reranked evidence chunks with stable source ids
  - output schema:
    - chat: concise Markdown answer
    - test plan: standard QA test plan Markdown
    - test cases: strict Jira-style JSON array, then UI table render
- If no active selected LLM exists, return a setup error telling the user to configure an active model in Models.

### Feature Behavior Updates
- Document chat:
  - ask question → advanced retrieval → LLM answer from evidence
  - if evidence missing: “No related data is available in indexed documents for this question.”
  - test-case questions return readable Jira-style table.
- Test Plan Generator:
  - selected documents + scope → advanced retrieval → selected LLM generates standard test plan
  - generated plan must not show retrieval metadata in normal mode.
- Test Case Generator:
  - feature description is the source requirement
  - retrieved chunks are examples/reference only
  - selected LLM outputs strict Jira JSON fields: title, module, testType, priority, preconditions, steps, testData, expectedResult, automationStatus.
  - reject malformed LLM JSON with a clear error instead of saving partial cases.

## Test Plan
- Reprocess an existing CSV testcase document and confirm chunk count changes to row-level chunks.
- Ask document chat: “please give me login related testcase”
  - expected: only login/auth/SSO rows appear; no SmartCode/Heatmap/AB Testing leakage.
- Ask unrelated question against selected docs.
  - expected: no-related-data response.
- Generate test cases from the domain SSO login requirement.
  - expected: cases cover Google/Microsoft domain detection, password disabled, provider icon, SSO redirect, non-configured domain, domain switching, malformed username.
- Generate test plan from selected requirement document.
  - expected: readable standard QA plan, no retrieval metadata, evidence-driven scope.
- Build checks:
  - backend `npm.cmd run build`
  - frontend `npm.cmd run typecheck`
  - frontend `npm.cmd run build`

## Assumptions
- Use local free embedding and reranker models first.
- LLM is required for final chat/test plan/test case output.
- Upstash Vector is available from existing env values.
- R2 remains optional; local document storage continues to work.
- OpenAI-compatible selected models are wired first; Anthropic/Google can remain configured but not active for generation until their adapters are added.


-------------------------------------------------------

# RAG Pipeline First Test Plan And Test Case Generation Upgrade

## Summary
Replace “indexed document” language and behavior with an ingestion-retrieval RAG pipeline model across Test Plan, Test Case, Document Chat, guidance, and status docs. Test Plan and Test Case generation will always retrieve relevant evidence from the full RAG pipeline using the user’s scope/requirement, then feed both the user input and retrieved evidence to the selected LLM. Fix the test case JSON failure by making generation schema-first, parser-tolerant, and recoverable.

## Key Changes
- Rename product language:
  - Replace user-facing “indexed documents”, “selected documents”, and “document context” with “RAG pipeline”, “ingested knowledge base”, or “retrieved evidence”.
  - Keep backend table names as-is for now to avoid unnecessary migration churn.
  - Update Test Plan, Test Case, Documents, dashboard copy, `guidance.md`, and project status docs.

- Remove document selection from generators:
  - Test Plan page removes the document checkbox list and sends only `{ name, scope }`.
  - Test Case page removes the document checkbox list and sends only `{ featureDescription, count, mode }`.
  - Backend generation schemas stop requiring or using `documentIds`; retrieval calls use the full RAG corpus with `retrieveContext(input, [])`.

- Add feature-level model selection for generators:
  - Extend `model_feature_settings` keys to include `test_plan_generator` and `test_case_generator`.
  - Models page `Feature Model Selection` adds dropdowns for Document Chat, Test Plan Generator, and Test Case Generator.
  - Test Plan uses the selected `test_plan_generator` model.
  - Test Case uses the selected `test_case_generator` model.
  - Missing model errors clearly say which feature model must be selected in Models.

- Improve RAG + LLM generation behavior:
  - Test Plan prompt: scope is the main requirement; retrieved evidence is grounding/context; output clean Markdown test plan.
  - Test Case prompt: feature description is the main requirement; retrieved evidence is grounding/context; output only strict JSON test cases.
  - If retrieval is weak, output should still use the user requirement and mark assumptions instead of failing or injecting unrelated evidence.
  - Debug retrieval may remain backend-only or hidden unless already exposed.

- Fix `LLM returned invalid test case JSON`:
  - Require a strict JSON object wrapper from the LLM: `{ "cases": [...] }` instead of a bare array.
  - Parse both wrapper and legacy array responses for compatibility.
  - Normalize common LLM variations:
    - `step` string -> `steps` array
    - missing nullable fields -> `null`
    - missing `automationStatus` -> `candidate`
    - numeric priority/type values -> strings
  - If validation still fails, make one repair attempt by sending the invalid output plus schema back to the same selected model.
  - Return a useful error with validation details only after repair fails.

## API And UI Changes
- Changed APIs:
  - `POST /api/test-plans/generate`: request becomes `{ name?: string, scope: string }`.
  - `POST /api/test-cases/generate`: request becomes `{ featureDescription: string, count?: number, mode?: "balanced" | "positive" | "negative" | "regression" }`.
  - Existing `documentIds` in these endpoints can be accepted temporarily but ignored to avoid breaking stale frontend calls.

- Model settings:
  - `GET /api/models/feature-settings` returns settings for `document_chat`, `test_plan_generator`, and `test_case_generator`.
  - `PUT /api/models/feature-settings/:featureKey` supports those three feature keys.

- UI:
  - Test Plan page says it generates from scope plus RAG pipeline retrieval.
  - Test Case page says it generates from feature requirement plus RAG pipeline retrieval.
  - No generator screen shows “Indexed documents” selection.
  - Models page lets the user assign tested models to Document Chat, Test Plan Generator, and Test Case Generator.

## Test Plan
- Configure and test a model, assign it to Test Plan Generator, generate a plan from a scope, and confirm output uses retrieved RAG evidence plus scope.
- Configure and test a model, assign it to Test Case Generator, generate cases from a feature description, and confirm no document selection is available.
- Generate domain SSO login cases and confirm Google, Microsoft, provider redirect, non-configured domain, domain switching, and malformed username cases appear.
- Force an imperfect LLM JSON response in development or with a mock and confirm parser normalization/repair prevents the generic invalid JSON failure.
- Search the repo/UI for old user-facing terms: `indexed documents`, `selected documents`, and replace where they describe generation behavior.
- Run:
  - Backend `npm.cmd run build`
  - Frontend `npm.cmd run typecheck`
  - Frontend `npm.cmd run build`

## Assumptions
- “Remove indexed document feature” means remove document selection and user-facing wording from generation workflows, not delete the ingestion storage tables.
- The RAG pipeline remains powered by uploaded/ingested files, chunks, embeddings, vector search, lexical search, and reranking.
- Test Plan and Test Case should each have their own saved model assignment in Models, like Document Chat.

--------------------------------------------------------------


# Universal Precision RAG Pipeline For Any Ingested Document

## Summary
Upgrade QA Robot’s RAG system so it works well for all source material, not only test case CSVs. The pipeline should handle product requirements, PRDs, user stories, acceptance criteria, API specs, release notes, support docs, test cases, Gherkin files, Markdown, PDF text, JSON/OpenAPI/Postman, and future document types. It will use document-aware ingestion, self-query retrieval, metadata filtering, hybrid search, reranking, and evidence validation before any LLM answer or generation.

## Key RAG Techniques

### 1. Document-Aware Ingestion
- Keep specialized chunking by file/content type:
  - CSV/testcase: one row per chunk.
  - Gherkin: feature/background/scenario blocks.
  - Markdown/text/PDF: heading-aware sections and requirement-like paragraphs.
  - JSON/OpenAPI/Postman: endpoint/request/item chunks.
  - General docs: paragraph/section chunks with overlap fallback.
- Every chunk gets universal metadata:
  - `documentName`
  - `documentType`
  - `chunkKind`
  - `sourceLocator`
  - `headingPath`
  - `pageOrSection`
  - `title`
  - `detectedEntities`
  - `detectedKeywords`
  - `metadataFields`
  - `searchableText`
- Store both:
  - raw evidence text
  - normalized searchable representation with field/value pairs and inferred labels.

### 2. Universal Query Understanding
- Parse the user query into:
  - `intent`: answer, requirement lookup, testcase lookup, test plan, test case generation, API lookup, release/change lookup
  - `keywords`: product/domain terms
  - `filters`: field/value constraints when present
  - `documentSignals`: requirement, API, release, test case, user story, acceptance criteria, bug, design
  - `requestedOutput`: table, summary, plan, JSON, acceptance criteria, test cases
- Filters must work dynamically for any metadata field:
  - CSV columns like priority, severity, assignee, release, squad.
  - Requirement fields like feature, epic, user role, status, component.
  - API fields like method, path, operationId, tag.
  - Document headings like “Login”, “SSO”, “Acceptance Criteria”.
- Do not hardcode only QA testcase fields.

### 3. Hybrid Multi-Stage Retrieval
Use several retrievers and merge results:

- **Structured metadata retriever**
  - exact/fuzzy metadata matches across all chunk types.
- **Sparse lexical retriever**
  - BM25-like scoring over raw text + searchable metadata.
  - strong for exact IDs, statuses, P1, endpoint paths, names, and headings.
- **Dense vector retriever**
  - local embeddings + Upstash Vector for semantic matches.
- **Parent/child retriever**
  - retrieve small precise chunks, then optionally include parent heading/section context.
- **Query expansion**
  - limited domain expansion:
    - login -> sign in, authentication
    - requirement -> acceptance criteria, user story
    - API -> endpoint, request, response
  - expansion must be low weight and never override exact filters.
- **RRF merge**
  - combine structured, lexical, and vector ranks.
- **Cross-encoder reranking**
  - rerank top candidates using query + text + metadata summary.

### 4. Evidence Validation And Answer Control
- Final evidence must pass validation:
  - required filters are satisfied if query contains explicit filters.
  - stale vector hits are ignored unless matching Postgres chunk exists.
  - duplicate or near-duplicate chunks are removed.
  - include diverse sections only after precision filters are satisfied.
- If exact evidence exists, never answer “not found.”
- If only partial evidence exists, answer with:
  - what matched
  - what requested filter/detail was missing
- If no evidence exists, return:
  - `No related data is available in the ingested knowledge base for this question.`
- LLM must answer only from:
  - user question/requirement
  - retrieved validated evidence

## Document Deletion
- Add:
  - `DELETE /api/documents/:id`
  - `DELETE /api/documents`
- Deletion removes:
  - uploaded local/R2 source file
  - `documents` row
  - all related `document_chunks`
  - Upstash Vector IDs
- Saved generated outputs are not deleted automatically.
- Retrieval must never return deleted source content because Postgres chunks remain the source of truth.

## UI And Debugging
- Documents page:
  - delete individual source
  - delete all uploaded sources
  - confirmation clearly says files, chunks, and vector references are removed.
- Debug retrieval mode:
  - parsed query intent
  - keywords
  - filters
  - document signals
  - retriever sources
  - metadata matches
  - lexical/vector/rerank scores
  - final evidence
- Normal output remains clean and hides technical metadata.

## Test Plan
- Ingest mixed files:
  - PRD/Markdown requirement
  - PDF product requirement
  - CSV test cases
  - Gherkin feature file
  - OpenAPI/Postman JSON
- Ask:
  - `what is the login SSO requirement?`
  - Expected: requirement/acceptance criteria chunks.
- Ask:
  - `give me login testcases with P1 priority`
  - Expected: testcase rows matching login + P1.
- Ask:
  - `which API endpoint handles login?`
  - Expected: API chunks with method/path.
- Ask:
  - `generate test plan for SSO login`
  - Expected: scope + validated RAG evidence feeds LLM.
- Ask:
  - `create test cases for SSO login`
  - Expected: user requirement + validated evidence feeds LLM.
- Delete one source:
  - Expected: no future retrieval from that source.
- Delete all sources:
  - Expected: no related data response.
- Run:
  - backend `npm.cmd run build`
  - frontend `npm.cmd run typecheck`
  - frontend `npm.cmd run build`

## Assumptions
- The same universal RAG pipeline should power Document Chat, Test Plan Generator, and Test Case Generator.
- Precision is more important than returning many loosely related chunks.
- Structured metadata and exact lexical matches should outrank vector similarity when the query contains IDs, fields, filters, or endpoint paths.


----------------------------------------------------

# Test Script Generation And Test Runner Reporting Upgrade

## Summary
Upgrade script generation from “placeholder code from saved cases” into an app-aware Playwright script generator. The user must provide the application URL, then choose either saved test cases or manual testcase text. The backend will inspect the target app page, combine page structure + testcase intent + selected scripting model, and generate executable Playwright files. The Test Runner will stop being ambiguous by clearly showing what script, app URL, browser, and tests will execute, then produce a readable run report.

## Key Changes

### Test Script Generator
- Make `App URL` mandatory before generation.
- Add testcase input mode:
  - `Saved test cases`: choose existing saved cases.
  - `Manual testcase text`: paste testcase steps/requirements into a textarea.
- Validate:
  - `appUrl` must be a valid `http://` or `https://` URL.
  - saved mode requires at least one saved testcase.
  - manual mode requires non-empty manual testcase text.
- Add backend page-inspection service:
  - Use Playwright in the backend to open the provided app URL.
  - Capture page title, URL, headings, buttons, links, inputs, labels, placeholders, roles, visible text snippets, and stable selector candidates such as `data-testid`, labels, role names, text, and CSS fallbacks.
  - If Playwright inspection fails, fall back to a lightweight HTML fetch and clearly mark the page context as partial.
- Generate scripts using:
  - app URL
  - selected or manual testcases
  - inspected page context
  - selected `scripting` model when configured
- Keep a deterministic fallback generator if no scripting model is configured, but it must clearly mark selectors as TODO when page context is insufficient.
- Generated files should include:
  - `package.json`
  - `playwright.config.ts` with `baseURL` set from the provided app URL
  - `tests/generated.spec.ts`
  - optional `pages/app-page.ts`
  - optional `data/test-cases.json`
  - optional `README.md`
- Store script metadata with the generated script:
  - app URL
  - testcase input mode
  - source testcase IDs or manual text summary
  - inspected page summary
  - generation warnings

### API And Data Model
- Update `POST /api/scripts/generate` request:
  - `name`
  - `appUrl`
  - `inputMode: "saved" | "manual"`
  - `testCaseIds?: string[]`
  - `manualTestCaseText?: string`
  - `framework: "playwright"`
  - `usePageObject`
  - `includeTestData`
  - `includeReadme`
- Add DB fields to `test_scripts`:
  - `app_url`
  - `input_mode`
  - `manual_test_case_text`
  - `page_context`
  - `generation_warnings`
- Preserve existing saved scripts by allowing nullable/default values in migration.

### Test Runner
- Replace the ambiguous “Start run” behavior with a clear run setup panel:
  - selected script name
  - app URL that will be tested
  - browser
  - number of tests discovered from generated script/testcase source
  - run mode: real Playwright execution
- Backend runner should execute generated Playwright files in an isolated temp workspace:
  - write generated files to temp run folder
  - install/use required Playwright runtime if available
  - run `npx playwright test --project=<browser> --reporter=json,line`
  - pass `BASE_URL=<script.appUrl>`
  - stream logs to UI
- If dependencies/browsers are missing, fail with a clear setup message instead of simulating success.
- Keep simulation only as an explicit development fallback, never as the default user-facing result.

### Reporting
- Add run detail/report view.
- Store structured run results in `test_runs.results`:
  - total tests
  - passed
  - failed
  - skipped
  - duration
  - per-test title/status/error/duration
  - browser
  - app URL
  - script name
  - stdout/stderr summary
- Runner UI should show:
  - live logs
  - summary cards
  - per-test result table
  - failure message/stack excerpt
  - run history with clickable row/details
- Optional artifacts for v1:
  - keep trace/screenshot paths if Playwright creates them
  - show links only if files are stored and accessible locally

## Test Plan
- Script Generator:
  - Generate with saved testcases and mandatory app URL.
  - Generate with manual testcase textarea and mandatory app URL.
  - Confirm missing app URL blocks generation.
  - Confirm saved mode with no selected cases blocks generation.
  - Confirm manual mode with empty textarea blocks generation.
  - Confirm generated `playwright.config.ts` uses the provided app URL as `baseURL`.
  - Confirm generated test code uses page-inspection selectors where available and avoids generic placeholder-only code.

- Runner:
  - Select a generated script and confirm the run panel shows script name, app URL, browser, and test count.
  - Start a run and verify real Playwright logs stream.
  - Confirm successful run creates a passed report with per-test rows.
  - Force a failing selector/assertion and confirm failed status, error message, and report details are saved.
  - Confirm run history opens previous report details.

- Verification:
  - backend `npm.cmd run db:generate`
  - backend `npm.cmd run db:migrate`
  - backend `npm.cmd run build`
  - frontend `npm.cmd run typecheck`
  - frontend `npm.cmd run build`

## Assumptions
- The app will use backend Playwright for page inspection and real execution. Codex MCP/browser tools can help during development verification, but the QA Robot app itself should not depend on Codex MCP being available.
- App URL must be reachable from the backend machine.
- Authentication setup is out of scope for this first upgrade; protected apps can still be supported later with saved auth state or login setup steps.
- BrowserStack/cloud execution is out of scope for v1 runner reporting; local Playwright execution is the default.

---------------------------------------------------------

# Vercel-Safe Script Generation And Cloud Runner Plan

## Summary
Move QA Robot away from local Playwright execution inside the main backend. Script generation can stay in the app, but browser inspection and test execution should use a cloud-safe runner path so any user can use it after deployment. The main Vercel/API app should create scripts, queue runs, display reports, and store results; a separate worker or browser automation provider should execute Playwright.

## Key Changes

### 1. Remove Local Browser Assumption From Main Backend
- Remove direct Playwright browser launch and child-process execution from the main backend.
- Keep script generation as code generation only.
- Make page inspection configurable:
  - default: lightweight HTML/metadata fetch for Vercel-safe inspection
  - optional: external browser inspection provider for dynamic apps
- Move `@playwright/test` out of the main backend dependency unless only used in a separate worker package.

### 2. Add Cloud Runner Architecture
- Add a dedicated Playwright worker for real execution.
- Recommended v1 deployment:
  - Vercel: frontend/API UI
  - Neon: database
  - Upstash QStash/Redis: queue run jobs and status
  - Worker: Railway/Fly.io/Render/Docker service with Playwright browsers installed
- Runner flow:
  - User clicks `Run`
  - API creates `test_runs` row with `queued`
  - API sends job to worker through QStash or worker endpoint
  - Worker downloads/receives generated script files, executes Playwright, stores report
  - UI polls or streams status/logs from DB/Redis

### 3. Update Runner Behavior
- Replace “run locally now” with cloud-safe run states:
  - `queued`
  - `running`
  - `passed`
  - `failed`
  - `cancelled`
- Main API must never fake success.
- If no worker is configured, `Run` should show:
  - `Runner worker is not configured. Configure RUNNER_WORKER_URL and QSTASH values to execute tests.`
- Reports remain visible even if live streaming is unavailable.

### 4. Script Generation
- Keep mandatory `App URL`.
- Keep saved testcase/manual testcase input.
- Generate Playwright project files, but do not execute them inside Vercel.
- Generated `README.md` should explain:
  - local run command for developer use
  - cloud worker execution path for deployed app
- Page inspection should mark context as:
  - `static_html`
  - `external_browser`
  - `unavailable`

### 5. Reporting
- Store final run report in `test_runs.results`.
- Store logs in DB or Redis-backed run log storage, not in memory.
- Report should include:
  - script name
  - app URL
  - browser/project
  - status
  - total/passed/failed/skipped
  - per-test result
  - error stack/message
  - artifact links if worker storage is configured

## Implementation Plan
- Refactor current backend runner so `/api/runs/start` creates a queued run instead of spawning Playwright.
- Add env variables:
  - `RUNNER_MODE=disabled|worker`
  - `RUNNER_WORKER_URL`
  - `QSTASH_TOKEN`
  - `QSTASH_CURRENT_SIGNING_KEY`
  - `QSTASH_NEXT_SIGNING_KEY`
  - optional `RUN_ARTIFACT_STORAGE_DRIVER=local|r2`
- Add worker API contract:
  - `POST /runner/jobs`
  - input: run id, script files, app URL, browser
  - output: accepted job id
  - callback/update: run logs and final report
- Move Playwright execution code into a separate worker package or service.
- Remove in-memory `runLogs` as source of truth; use DB/Redis-backed logs.
- Update Runner UI to show worker configuration status and queued/running/report states.
- Update guidance docs with Vercel deployment and worker setup.

## Test Plan
- With `RUNNER_MODE=disabled`, click Run:
  - expected: clear worker-not-configured message, no fake pass.
- With worker configured, click Run:
  - expected: run becomes queued, then running, then passed/failed.
- Stop worker and click Run:
  - expected: queued/failed with clear worker connection error.
- Generate script from saved testcase:
  - expected: script stores app URL and files, no local execution required.
- Generate script from manual testcase:
  - expected: same behavior.
- Verify report:
  - expected: run history opens final per-test report.
- Run:
  - backend `npm.cmd run build`
  - frontend `npm.cmd run typecheck`
  - frontend `npm.cmd run build`

## Assumptions
- QA Robot will deploy the main app/API on Vercel or another serverless platform.
- Real browser execution should run outside Vercel in a worker or managed browser service.
- Local developer execution can remain documented, but it must not be the production execution path.

--------------------------

What The Product Should Add
Yes, we should add two execution options:

Cloud/VM Worker

Best for production/Vercel.
You deploy a runner worker on VM/Railway/Render/Fly.
QA Robot sends jobs to that worker.
Local Machine Runner

Best for development.
You run a small runner process on your machine.
It connects to QA Robot or exposes a local/tunnel URL.
Your local machine has Playwright browsers installed.
The main Vercel app should never install browser binaries or execute browsers directly. The runner should be separate.





