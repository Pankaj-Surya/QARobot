# QA Robot New Project Status

Last updated: 2026-05-26

## Important Boundary

- The existing builder-generated app was not modified for this step.
- New work was created in separate folders:
  - `qarobot-frontend`
  - `qarobot-backend`

## Created

- `qarobot-frontend`: Next.js 14 TypeScript app scaffold with Tailwind CSS, app router pages, shared shell, module cards, and a single API client using `NEXT_PUBLIC_API_URL`.
- `qarobot-backend`: Fastify TypeScript app scaffold with CORS, multipart support, route modules, service stubs, environment examples, R2/Upstash client helpers, encryption utility, and Drizzle schema for the core tables.
- Project-local `.gitignore` files for generated build output, dependencies, and local env files.
- Workspace-level `.gitignore` and `.rgignore` now skip dependency folders, build output, logs, local env files, and TypeScript build cache to keep future repo scans token-efficient.
- Initial Drizzle migration generated at `qarobot-backend/src/db/migrations/0000_rainy_jasper_sitwell.sql`.
- Document module now has database-backed list/detail routes, multipart upload to Cloudflare R2, document processing from R2, PDF/text/JSON/YAML/Gherkin extraction, 512-word chunking with overlap, chunk persistence, and indexed/failed status updates.
- Documents frontend now has a real upload control, status table, polling for processing states, and a chunk preview panel.
- Backend now loads local `.env` files without an extra dependency, validates the encryption key length, and supports local document storage by default while keeping R2 available for later.
- Model Connector now stores provider configs in Postgres with encrypted API keys, lists saved configs without exposing secrets, supports activating one model per task type, and exposes a stored-config test endpoint.
- Models frontend now has a working provider configuration form, active/default badges, test buttons, and activation controls.
- RAG retrieval now has a database keyword fallback over stored document chunks.
- Test Plan Generator now generates a draft from scope plus retrieved RAG evidence, saves plans to Postgres, lists saved plans, and reloads saved content into the editor.
- RAG retrieval now exposes top-K method, query terms, candidate chunk count, score, matched terms, and retrieval reason.
- Documents page now includes an Ask RAG Pipeline panel for testing RAG questions against the ingested knowledge base.
- CSV and Gherkin processing now uses line-aware chunking so rows/scenarios are less likely to be split into confusing word windows.
- Test plan drafts now display matching requirement excerpts instead of raw chunk previews.
- Document chat answers now render as readable Markdown instead of raw preformatted chunks, use Jira-style tables for test-case answers, and return a clear no-related-data message when no chunk matches.
- Test plan drafts now use a standard QA test plan structure without technical retrieval metadata in the generated deliverable.
- Test Plan page now has Preview/Edit modes with a Markdown previewer for headings, lists, and tables.
- Test Case Generator now creates Jira-style draft cases from feature requirements plus retrieved RAG evidence, saves selected cases with sequential `TC-###` IDs, and lists saved cases.
- Test Case Generator now treats the feature description as the source requirement and retrieves reference evidence from the full RAG pipeline, preventing unrelated old test cases from replacing new requirements.
- Added specific deterministic coverage for domain-based SSO login requirements such as Google/Microsoft domains, disabled password field, provider icon display, SSO redirect, non-configured domains, domain switching, and malformed usernames.
- Added advanced RAG foundation: chunk metadata schema/migration, document-aware chunk builders, local embedding/reranker service with deterministic fallback, Upstash Vector indexing/query helpers, hybrid lexical + vector retrieval, RRF merge, reranking, and strict no-unrelated-fallback behavior.
- Added universal precision RAG retrieval: chunk-level searchable metadata, dynamic field/value query parsing, structured metadata scoring, lexical/vector/RRF retrieval, reranking, filter validation, and debug visibility for parsed constraints.
- Documents can now be deleted individually or all at once, removing uploaded source files, chunk rows, and vector references where possible while preserving saved generated outputs.
- Document Chat now uses the selected Document Chat feature model with retrieved evidence and hides retrieval metadata unless debug is enabled.
- Test Plan Generator now uses the selected Test Plan Generator feature model with retrieved evidence.
- Test Case Generator now uses the selected Test Case Generator feature model, validates JSON, normalizes common field variations, and attempts one JSON repair before failing.
- Test Script Generator now creates Playwright starter file sets from saved test cases, including optional page object, test data JSON, and README files.
- Test Runner now creates database-backed run records and streams simulated SSE execution logs to the frontend, then updates run history.
- Test Cases, Scripts, and Runner frontend pages now provide working end-to-end UI flows.

## Current Completion Against Build Order

- Step 1 started: separate frontend and backend projects now exist.
- Step 1 partially complete: Fastify and Next.js project files are scaffolded.
- Step 1 partially complete: Drizzle schema file exists for documents, chunks, model configs, test plans, test cases, scripts, runs, and heal logs.
- Step 1 partially complete: dependencies are installed and lockfiles were generated.
- Step 1 partially complete: initial Drizzle migration is generated but still needs execution against Neon.
- Step 1 complete for database bootstrapping: initial Drizzle migration has been applied to Neon.
- Step 1 partially complete: document storage works locally now; Cloudflare R2 remains optional until R2 credentials are added.
- Step 1 pending: Upstash Vector, Redis, QStash, and AI provider integrations need implementation.
- Step 2 partially complete: document upload, local storage, processing, and chunk indexing were tested against Neon.
- Step 3 partially complete: model configuration storage, encryption, listing, activation, and local credential validation are implemented; live provider API calls are still pending.
- Step 4 started: test plan draft generation, RAG fallback retrieval, save, and list flows are implemented without live AI streaming yet.
- Step 5 partially complete: test case generation, preview, save, and list flows are implemented with deterministic RAG-assisted generation.
- Step 6 partially complete: static Playwright script generation and file viewing are implemented; Playwright MCP selector discovery is pending.
- Step 7 partially complete: runner run creation, SSE streaming, and history are implemented with simulated execution; real Playwright child-process execution is pending.
- Step 8 is not started yet.
- Advanced RAG chunk metadata migration has been applied to Neon.

## Verification Performed

- `qarobot-backend`: `npm.cmd install` completed.
- `qarobot-backend`: `npm.cmd run build` completed successfully.
- `qarobot-backend`: `npm.cmd run db:generate` completed successfully after allowing Drizzle Kit to create its local Windows cache folder.
- `qarobot-backend`: `.env` was created locally from `.env.example` for runtime use. `.env` is ignored by git.
- `qarobot-backend`: `npm.cmd run db:migrate` completed successfully against Neon after network approval.
- `qarobot-backend`: `/health` returned HTTP 200.
- `qarobot-backend`: `/api/models` returned HTTP 200 with an empty model list before configs were added.
- `qarobot-backend`: uploaded a smoke-test text document to local storage, processed it, and confirmed it reached `indexed` with 1 chunk.
- `qarobot-backend`: `POST /api/test-plans/generate` returned a draft that included the indexed smoke-test document chunk.
- `qarobot-backend`: `POST /api/documents/ask` returned RAG answers with top-K retrieval metadata and source chunks.
- `qarobot-backend`: reprocessed an existing CSV document with line-aware chunks and confirmed login retrieval returns login-related rows.
- `qarobot-backend`: `npm.cmd run build` completed successfully after the chat/test-plan formatting changes.
- `qarobot-frontend`: `npm.cmd run typecheck` and `npm.cmd run build` completed successfully after adding the Markdown previewer.
- `qarobot-backend`: `npm.cmd run build` completed successfully after adding test cases, scripts, and runner routes.
- `qarobot-frontend`: `npm.cmd run typecheck` and `npm.cmd run build` completed successfully after adding Test Cases, Scripts, and Runner pages.
- `qarobot-backend`: `npm.cmd run build` completed successfully after fixing requirement-first test case generation.
- `qarobot-frontend`: `npm.cmd run build` completed successfully after clarifying Test Case Generator source-of-truth behavior in the UI.
- `qarobot-backend`: `npm.cmd run build` completed successfully after adding advanced RAG, local embedding/reranker service, vector indexing, and LLM adapter changes.
- `qarobot-frontend`: `npm.cmd run typecheck` and `npm.cmd run build` completed successfully after adding the Document Chat debug toggle.
- `qarobot-backend`: `npm.cmd run db:migrate` completed successfully after approval and applied the advanced RAG chunk metadata migration.
- `qarobot-backend`: `npm.cmd run build` completed successfully after the migration.
- `qarobot-frontend`: `npm.cmd run typecheck` and `npm.cmd run build` completed successfully after the migration.
- `qarobot-frontend`: `npm.cmd install` completed.
- `qarobot-frontend`: Next.js was updated within the required 14.x line to `14.2.35` after npm warned that the initial scaffold version was vulnerable.
- `qarobot-frontend`: `npm.cmd run typecheck` completed successfully.
- `qarobot-frontend`: `npm.cmd run build` completed successfully.
- `qarobot-frontend`: opened `/models` in the in-app browser and verified the page rendered with no console errors.
- Searched the new project folders for old Anything-domain and token references; no matches were found.
- Attempted to start both dev servers. `Start-Process` failed in this Windows shell because of duplicate `Path/PATH` environment keys, and fallback PowerShell jobs did not keep the servers alive long enough to bind ports.

## Known Notices

- npm audit currently reports dependency vulnerabilities:
  - backend: 10 total, 4 moderate and 6 high.
  - frontend: 7 total, 3 moderate and 4 high.
- I did not run `npm audit fix` because it can change dependency versions beyond the requested architecture and should be handled deliberately.

## Next Recommended Task

Reprocess uploaded documents, configure feature models for Document Chat, Test Plan Generator, and Test Case Generator, then validate outputs against the domain SSO login scenario.
