# QA Robot Testing Guidance

Use this file after each development pass to verify the feature that was just built. Run commands from the workspace root unless a step says otherwise.

## 1. Environment And Database

Purpose: confirm the backend can load local env values and connect to Neon.

Steps:

1. Confirm `qarobot-backend/.env` exists.
2. Confirm `qarobot-backend/.env` contains at least:

```bash
PORT=3001
FRONTEND_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://...
DOCUMENT_STORAGE_DRIVER=local
LOCAL_DOCUMENT_STORAGE_DIR=documents
ENCRYPTION_KEY=...
```

3. Run the migration:

```bash
cd qarobot-backend
npm.cmd run db:migrate
```

Expected result:

- Drizzle prints `migrations applied successfully`.
- If migrations were already applied, it should complete without creating duplicate tables.

## 2. Backend Health

Purpose: confirm the Fastify service starts and reads `.env`.

Steps:

1. Start the backend:

```bash
cd qarobot-backend
npm.cmd run dev
```

2. Open this URL:

```text
http://127.0.0.1:3001/health
```

Expected result:

```json
{"ok":true,"service":"qarobot-backend"}
```

## 3. Frontend Startup

Purpose: confirm the Next.js app starts and can call the backend.

Steps:

1. Start the frontend in a second terminal:

```bash
cd qarobot-frontend
npm.cmd run dev
```

2. Open:

```text
http://127.0.0.1:3000
```

Expected result:

- QA Robot dashboard loads.
- Sidebar navigation shows Documents, Models, Plans, Cases, Scripts, Runner, and Healer.

## 4. Documents Feature

Purpose: verify local document upload, processing, database rows, and chunk preview.

Steps:

1. Make sure backend and frontend are both running.
2. Open:

```text
http://127.0.0.1:3000/documents
```

3. Upload a small `.txt`, `.md`, `.csv`, `.json`, `.yaml`, `.feature`, or `.pdf` file.
4. Wait for processing to finish.

Expected result:

- The document appears in the table.
- Status becomes `indexed`.
- Chunk count is greater than `0`.
- Selecting the row shows chunk preview text.
- A copy of the uploaded file exists under:

```text
qarobot-backend/documents/
```

API check:

```bash
curl.exe http://127.0.0.1:3001/api/documents
```

Expected API result:

- JSON contains a `documents` array.
- Uploaded document has `status: "indexed"`.

## 5. Model Connector Feature

Purpose: verify encrypted model configuration storage, listing, activation, and live provider/model testing.

Steps:

1. Open:

```text
http://127.0.0.1:3000/models
```

2. Choose a provider.
3. Choose a task type such as `planning`.
4. Enter a model name.
5. For non-Ollama providers, enter any test API key value for now.
6. Click `Save active model`.
7. Click `Test connection` on the saved model.
8. In `Feature Model Selection`, choose tested models for `Document Chat`, `Test Plan Generator`, and `Test Case Generator`.
9. Click `Save`.

Expected result:

- Saved model appears in Configured Models.
- It has an `active` badge for its task type.
- Test connection makes a live minimal request to the provider and returns `connected` only when the API key/base URL and model name are accepted.
- If the model is retired or misspelled, the UI shows the provider error before that model is used by document chat or generators.
- Document Chat, Test Plan Generator, and Test Case Generator use the models selected in `Feature Model Selection`; they do not use active-model fallback.
- API keys are not shown in the UI or returned by `GET /api/models`.

API check:

```bash
curl.exe http://127.0.0.1:3001/api/models
```

Expected API result:

- JSON contains a `models` array.
- Each model may include `hasApiKey`.
- It must not include the raw API key.

Provider notes:

- OpenAI, Groq, and Ollama are wired for live generation and test connection.
- Anthropic and Google can be stored, but test connection should report that those providers are not wired yet until their adapters are added.
- Groq default is `llama-3.3-70b-versatile`; avoid retired Groq model names such as `llama-3.1-70b-versatile`.

## 6. RAG Pipeline Retrieval

Purpose: verify ingested knowledge can be retrieved through the RAG pipeline before generation.

Steps:

1. Upload a document from the Documents page and wait for automatic ingestion to finish.
2. Open the Documents page.
3. Optionally select ingested source material to preview its chunks.
4. In `Ask RAG Pipeline`, ask a question such as:

```text
please give me login related testcase
```

or:

```text
please tell me exact requirement to implement login
```

5. Review the answer and Retrieved Chunks section.

Expected result:

- Answer is generated from retrieved RAG evidence.
- Document Chat uses the model selected in Models -> Feature Model Selection.
- Selecting source material only changes the preview panel; chat searches the full ingested knowledge base.
- The main answer is readable Markdown, not raw chunk text.
- Test-case answers use a Jira-style table with ID, title, module, priority, type, preconditions, steps, and expected result.
- If no matching chunk is found, the answer says no related data is available instead of inventing content.
- Retrieval details are hidden behind the `Retrieval details` expander for debugging.
- If no Document Chat model is selected, the answer request returns: `No model is selected for Document Chat. Select one in Models -> Feature Model Selection.`
- If the selected model fails provider validation, use Models -> `Test connection` to verify the stored model before asking again.

Rebuild ingestion:

1. Open the Documents page.
2. Click `Rebuild ingestion`.
3. Confirm the prompt.

Expected rebuild result:

- Existing uploaded document records remain.
- Existing chunk rows and vector entries are cleared where possible.
- All stored documents are reprocessed from local/R2 storage.
- Chunk counts refresh after rebuild completes.

Delete uploaded sources:

1. To remove one source, click its delete button in the Documents table.
2. To remove everything, click `Delete all uploads`.
3. Confirm the prompt.

Expected delete result:

- Uploaded source files are removed from local/R2 storage where possible.
- Related RAG chunks are removed from Postgres.
- Related vector references are removed from Upstash Vector where possible.
- Saved generated plans, cases, scripts, and runs are not deleted.
- Future retrieval no longer returns deleted source content.

Current behavior:

- Retrieval uses hybrid lexical + vector + rerank when chunk metadata migration has been applied and source material is reprocessed.
- Precision retrieval uses self-query parsing, dynamic metadata filters, lexical scoring, vector search, RRF, reranking, and evidence validation.
- Multiline CSV testcase rows should remain one complete chunk. For example, `TC_BSD_009` should keep all three test steps, `Test Data`, `Expected Result`, `Priority`, `Component`, and `Labels` aligned with the original CSV headers.
- Queries such as `give me login related testcase`, `please give me login related testcases with Priority - High`, `assigned to Neha`, or custom CSV fields such as `release 25.6` should match metadata when those fields exist in the ingested source.
- PRD/test plan questions should retrieve the matching section first. For example, `give me Functional Requirements for Product Listing area` should surface the PRD Functional Requirements section, and `does Test Environments mention Windows 11 and which browsers are supported?` should surface the Test Environments evidence.
- If Upstash Vector or local model loading is unavailable, lexical retrieval still works as a fallback.
- Normal answers hide metadata; enable `Show retrieval debug details` in Document Chat to inspect retrieval.

Required upgrade step after pulling this change if the migration has not already been applied:

```bash
cd qarobot-backend
npm.cmd run db:migrate
```

After migration, reprocess uploaded documents from the Documents page so row/section chunks and vector metadata are recreated.

## 7. Test Plan Generator Feature

Purpose: verify draft generation, editing, saving, listing, and reloading.

Steps:

1. Open:

```text
http://127.0.0.1:3000/test-plans
```

2. Enter a plan name.
3. Enter a scope.
4. Click `Generate draft`.
5. Review or edit the generated draft.
6. Click `Save`.

Expected result:

- Draft appears in the editor.
- Draft appears in Preview mode by default.
- Preview mode renders headings, lists, and tables in a readable layout.
- Edit mode allows raw Markdown edits.
- Draft follows a standard QA test plan structure: scope, objective, source requirement summary, in scope, out of scope, strategy, scenario matrix, test data, entry criteria, exit criteria, and risks.
- The backend retrieves relevant RAG evidence from the full ingested knowledge base before calling the selected LLM.
- If no Test Plan Generator model is selected, the request returns a clear missing feature-model message.
- Saved plan appears under Saved Plans.
- Clicking a saved plan reloads its name, scope, and content into the form/editor.

API check:

```bash
curl.exe http://127.0.0.1:3001/api/test-plans
```

Expected API result:

- JSON contains a `plans` array.
- Saved plans include `name`, `scopeDescription`, `content`, and `createdAt`.

Current behavior:

- Draft generation uses the Test Plan Generator model selected in Models -> Feature Model Selection.
- Live AI streaming is not wired yet; generation returns the completed Markdown draft.

## 8. Build Verification

Purpose: confirm both apps compile after changes.

Backend:

```bash
cd qarobot-backend
npm.cmd run build
```

Frontend:

```bash
cd qarobot-frontend
npm.cmd run typecheck
npm.cmd run build
```

Expected result:

- Backend TypeScript build completes.
- Frontend typecheck completes.
- Next.js production build completes.

## 9. Test Case Generator

Purpose: verify Jira-style test case generation, preview, save, and listing.

Steps:

1. Start backend and frontend.
2. Open:

```text
http://127.0.0.1:3000/test-cases
```

3. Enter a feature description, for example:

```text
Generate login test cases for valid login, invalid password, 2FA, and forgot password flows.
```

4. Choose count and mode.
5. Click `Generate cases`.
6. Review the preview table.
7. Click `Save`.

Expected result:

- Generated cases appear in a Jira-style table.
- Saved cases get IDs like `TC-001`, `TC-002`.
- Saved cases remain visible after refresh.
- For specific new requirements, the generated cases should follow the feature description first.
- The backend retrieves relevant RAG evidence from the full ingested knowledge base before calling the selected LLM.
- If the LLM returns imperfect JSON, the backend normalizes common field variations and makes one repair attempt.
- A Test Case Generator model must be selected in Models -> Feature Model Selection.

Regression check for domain SSO login:

Use this feature description:

```text
Please create test cases for login feature with additional requirement for specific domain user like google.com, microsoft.com. We will show username field on basis of domain. If domain is provided domain then disable password field and show Google or Microsoft icon in sign-in button. When we click on that button it should open SSO screen.
```

Expected generated topics:

- Google domain disables password field and shows provider icon.
- Microsoft domain disables password field and shows provider icon.
- Clicking provider sign-in opens SSO screen.
- Non-configured domain keeps password login enabled.
- Changing username domain updates login mode.
- Blank or malformed username does not trigger SSO mode.

## 10. Test Script Generator

Purpose: verify app-aware Playwright scripts can be generated from saved test cases or manual testcase text.

Steps:

1. Open:

```text
http://127.0.0.1:3000/scripts
```

2. Enter the mandatory `App URL`, such as `http://127.0.0.1:3000`.
3. Choose `Saved cases` and select one or more saved test cases.
4. Choose script options: page object, test data file, README.
5. Click `Generate script`.
6. Select generated files from the file tree.

Manual testcase check:

1. Switch testcase source to `Manual text`.
2. Paste testcase steps and expected result into the textarea.
3. Click `Generate script`.

Expected result:

- A script record is saved.
- The script context shows app URL, input mode, page title when inspection succeeds, and generation warnings if any.
- File tree includes files such as `package.json`, `playwright.config.ts`, `tests/generated.spec.ts`, and optionally `pages/app-page.ts`, `data/test-cases.json`, `README.md`.
- `playwright.config.ts` uses the provided app URL as `baseURL`.
- Code viewer displays the selected file content.
- Page inspection mode is `static_html` by default for Vercel safety, or `external_browser` when `PAGE_INSPECTION_WORKER_URL` is configured.
- If no Test Script Generator model is selected, deterministic fallback generation is used and uncertain selector actions are marked with TODO comments.
- A Test Script Generator model can be selected in Models -> Feature Model Selection.

## 11. Test Runner

Purpose: verify cloud-worker run queuing, status/log streaming, run history, and saved reports.

Steps:

1. Generate at least one script.
2. Open:

```text
http://127.0.0.1:3000/runner
```

3. Select a generated script.
4. Select a browser.
5. Confirm the run setup panel shows script name, app URL, test count, browser, configured mode, Connect Runner, and the two supported execution options.
6. For local development, start `qarobot-runner-worker` on your machine, enter `http://localhost:4001` as Worker URL, enter `http://localhost:3001` as Backend callback URL, then click `Test connection` and `Save connection`.
7. For production/Vercel, deploy `qarobot-runner-worker` to a VM/Railway/Render/Fly service, then save the deployed worker URL and backend callback URL from the Runner page.
8. If no connection is saved, confirm the UI says the runner worker is not configured and the run button is disabled.
9. If the worker connection is saved and healthy, click `Queue runner job`.

Expected result:

- Live logs appear in the log panel.
- Run Report shows status, total, passed, failed, duration, app URL, browser, and per-test rows.
- Run history shows status, browser, total tests, passed count, failed count, started time, and completed time.
- Clicking a run history row opens its saved report.
- The main Vercel/API app does not execute Playwright or require browser binaries; only `qarobot-runner-worker` installs and runs Playwright.
- Worker logs/results are stored in the run result payload so reports remain visible after refresh.
- If the worker is missing or unreachable, the run fails with a clear worker configuration/dispatch error and never shows fake success.

## 12. Known Not Implemented Yet

These are planned but not complete:

- AI streaming responses from Fastify to frontend.
- Upstash Redis caching.
- QStash async document processing callbacks.
- Cloudflare R2 storage mode.
- Playwright MCP script generation.
- Authenticated app setup for generated scripts.
- BrowserStack/cloud runner execution.
- Test healer workflow.
