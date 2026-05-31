#Create QA Robot Web App only

## Architecture Decision: Frontend + Backend Separate

**Frontend:** Next.js 14 with TypeScript, deployed on Vercel. Handles all UI, streaming responses, code editor views, file trees.

**Backend:** Node.js with Fastify (better than Express for this use case). Fastify is faster, has built-in TypeScript support, better streaming support for AI responses, and a plugin ecosystem that covers everything you need. Deployed on Render.com as a persistent service, not serverless. This matters because test execution needs long-running processes.

**Why not Express?** Fastify handles streaming, multipart uploads, and concurrent requests more cleanly. For an AI-heavy app that streams responses and runs long test jobs, Fastify is the better choice. That said, if your team knows Express deeply, it works fine too.

---

## Revised Tech Stack

**Frontend:** Next.js 14, TypeScript, Tailwind CSS, Recharts for charts, TipTap for rich text editing, Monaco Editor for code viewing and editing, Vercel AI SDK useCompletion and useChat hooks for streaming UI.

**Backend:** Node.js with Fastify, TypeScript, deployed on Render.com free tier as a persistent web service.

**Vector Database:** Upstash Vector, serverless HTTP-based, free tier covers 10,000 vectors which handles roughly 125 to 250 documents.

**Cache and Queues:** Upstash Redis for caching RAG results and AI responses. Upstash QStash for async document processing jobs.

**Database:** Neon PostgreSQL via Drizzle ORM for all structured data.

**File Storage:** Cloudflare R2 for documents, screenshots, test artifacts.

**Playwright MCP:** Integrated into the test runner. The backend spins up a Playwright MCP server instance that the AI model can call as tools during test healing and script generation. This means the AI can actually interact with the browser, inspect elements, and suggest real selectors rather than guessing.

---

## Playwright MCP Integration - How It Works

This is the most important architectural decision in the whole system. Instead of just asking an AI to generate scripts blind, you wire the Playwright MCP server into the backend so the AI has actual browser tools available.

During script generation, if the user has added an app URL, the backend starts a Playwright MCP server, connects the AI model to it via the MCP protocol, and the AI can call tools like navigate, click, screenshot, get element info, and find selector to actually explore the app and write scripts based on real DOM state rather than guessing.

During test healing, when a selector breaks, the backend opens the page in Playwright MCP, the AI uses the screenshot and DOM tools to find what the element became, and suggests a new selector with real confidence.

The Playwright MCP server runs inside your Render.com backend service as a child process. You use the official @playwright/mcp package and connect to it via stdio or a local HTTP port.

---

## Folder Structure

**Backend repo** called qarobot-backend:

The src folder contains routes (one file per module: documents, models, test-plans, test-cases, scripts, runner, healer), services (rag service, ai adapter, playwright mcp service, document parser, chunker, embedder), db (drizzle schema, migrations, client), lib (r2 client, upstash clients, encryption util), and a main index.ts that wires Fastify together.

**Frontend repo** called qarobot-frontend:

The app folder contains pages for each module. A lib folder has the API client that talks to the Fastify backend. A components folder has shared UI. An env file points NEXT_PUBLIC_API_URL at the Render.com backend URL.

---

## Database Schema (Core Only)

You need six tables for the core build.

**documents** table stores id, name, file type, file size, r2 key (the path in Cloudflare R2), status (uploading, processing, indexed, failed), error message if failed, chunk count, created at.

**document chunks** table stores id, document id as foreign key, chunk index, chunk text preview (first 200 characters), full text, vector id in Upstash Vector, created at.

**model configs** table stores id, provider name, encrypted API key or base URL, model name, task type (planning, generation, scripting, healing), is active boolean, created at.

**test plans** table stores id, name, scope description, content as text, ai model used, source document ids as JSON array, created at.

**test cases** table stores id, tc id string like TC-001, title, module, test type, priority, preconditions, steps as JSON array, test data, expected result, automation status, created at, linked plan id.

**test scripts** table stores id, name, framework, test case ids as JSON array, files as JSON object (path to content map), created at.

**test runs** table stores id, script id, status, browser, started at, completed at, total tests, passed count, failed count, results as JSON, log url in R2.

**heal logs** table stores id, script id, test case id, broken selector, suggested selector, confidence score, screenshot url, status (pending, approved, rejected, auto healed), created at.

---

## Module by Module Build Plan

### Module 1: Document Storage and RAG Pipeline

The frontend shows a drag and drop upload zone. Files go directly from the browser to a POST /api/documents/upload multipart endpoint on the Fastify backend. The backend validates file type, streams the file to Cloudflare R2, inserts a record in Postgres with status uploading, then publishes a QStash message to trigger processing. Returns the document ID immediately so the frontend can poll for status.

The QStash callback hits POST /api/documents/process on the backend. The backend downloads the file from R2, routes to the correct parser, extracts text, chunks it into 512-token windows with 50-token overlap, generates embeddings, upserts into Upstash Vector with document id and chunk index as metadata, then marks the document as indexed in Postgres.

Parsers: pdf-parse for PDF, mammoth for Word, xlsx for Excel, plain text for CSV and Markdown, JSON stringify for OpenAPI and Postman collections, plain text for Gherkin feature files.

The frontend Documents page shows the upload zone at top, a list of documents below with status badges that update by polling GET /api/documents every 3 seconds while any document is in processing state. Clicking a document opens a side panel with the text preview and chunk count.

### Module 2: Model Connector

The frontend shows a grid of provider cards. Clicking a card opens a configure modal. For API key providers there is a masked text input and a model selector dropdown populated by calling the provider's model list API when the user clicks Fetch Models. For Ollama there is a base URL input.

The backend POST /api/models/configure encrypts the API key using AES-256-GCM and stores it in Postgres. GET /api/models lists all configured models. POST /api/models/test sends a single cheap prompt to verify the connection.

The AI adapter in the backend is a single getModel(taskType) function that queries Postgres for the default model for that task type, decrypts the key, and returns a configured Vercel AI SDK model instance. Every generation route calls getModel and never hardcodes a provider.

Task type defaults are set on the Settings page with four dropdowns: one each for planning, case generation, script generation, and healing.

### Module 3: Test Plan Generator

The frontend form has fields for plan name, scope textarea, document multi-select (populated from the indexed documents list), testing type checkboxes, and a model override dropdown. Clicking Generate calls POST /api/test-plans/generate and immediately sets up a streaming response consumer using the Fetch API with a ReadableStream reader. The text appears word by word as it streams in.

The backend route queries Upstash Vector with the scope text, filters by selected document IDs, retrieves top 5 most relevant chunks, builds a structured prompt with those chunks as context, then calls streamText from the Vercel AI SDK and pipes the readable stream directly into the Fastify reply stream. After the stream ends the frontend saves the completed plan via POST /api/test-plans/save.

The completed plan is displayed in a read-only accordion view. An Edit button opens TipTap editor with the content pre-loaded. Download as PDF uses pdf-lib on the backend, download as DOCX uses the docx npm library. Both served as file downloads from GET /api/test-plans/:id/export.

### Module 4: Test Case Generator

The frontend modal has a feature description textarea, generation mode radio buttons, and a count input. After generation it shows a preview table where the user can deselect rows before saving. The main Test Cases page shows a filterable, sortable table with all saved cases.

The backend POST /api/test-cases/generate queries RAG for context, builds a prompt that includes the context chunks and instructs the AI to return a JSON array only with no markdown or extra text, calls the AI, parses the JSON, validates each object has the required fields, and returns the array. The frontend renders this as the preview table.

POST /api/test-cases/save receives the selected rows, auto-increments the TC number by querying MAX tc_id in Postgres with a transaction to prevent duplicates, and inserts all rows.

Export: GET /api/test-cases/export?format=csv generates a CSV with all columns formatted for Jira import. Excel export uses the xlsx library.

### Module 5: Test Script Generator with Playwright MCP

This is the most interesting module. The frontend shows the script generator modal with framework selector cards and toggles for page object model, test data file, and readme. After generation it shows a file tree on the left and Monaco Editor on the right. The user can edit any file before downloading as a ZIP.

The backend POST /api/scripts/generate does something smarter than just asking the AI to write scripts. If the user has app URLs crawled and stored in the vector database, the route first retrieves those element chunks from Upstash Vector. If a URL is available and the user's app is accessible, the route starts a Playwright MCP session.

The Playwright MCP session works like this. The backend spawns a Playwright MCP server process. It builds the AI prompt that includes the test cases, the framework choice, any known selectors from the vector database, and tells the AI it has browser tools available. The AI generates scripts using real selectors from the DOM rather than placeholder selectors. The MCP session is closed after generation completes.

For the case where no URL is available, the AI generates scripts using the selectors from documents and vector context only, with placeholder comments where selectors are uncertain.

The generated output is a JSON object mapping file paths to file contents. The backend stores this in Postgres and returns it to the frontend. The frontend reconstructs the file tree from the path keys and populates Monaco Editor.

ZIP download: the backend receives a POST /api/scripts/:id/download, reads the files JSON from Postgres, uses the archiver library to create a ZIP in memory, and streams it back.

### Module 6: Test Runner and Test Healer

The test runner runs on the same Render.com backend service. It is not serverless. This matters because Playwright needs a persistent process.

The frontend Run Configuration panel sends POST /api/runs/start with the script ID, browser choice, and options. The backend creates a run record in Postgres with status pending, then kicks off the run asynchronously. It does not wait for the run to finish before responding. It returns the run ID immediately.

The frontend then connects to a Server-Sent Events stream at GET /api/runs/:id/stream. The Fastify backend holds this connection open and pushes log lines as they arrive. Each log line is a JSON object with a type (info, pass, fail, warn) and a message string. The frontend colors each line accordingly.

The actual test execution: the backend writes the script files to a temp directory, runs npm install if needed (or uses a pre-installed node_modules cache), then spawns a child process running npx playwright test with the --reporter=json flag plus a custom reporter that pipes each test result to the SSE stream via an internal event emitter. When the child process exits, the backend updates the run record in Postgres, uploads the full log to R2, and sends a final SSE event to close the stream.

**Test Healer integration:** When a test fails with an element not found error, the test runner captures the broken selector from the error output, takes a full page screenshot using Playwright, and sends both to POST /api/healer/analyze.

The healer route starts a Playwright MCP session, navigates to the page where the selector broke, uses the MCP screenshot and DOM inspection tools to get the current page state, then calls the AI configured for healing with the broken selector, the current screenshot, and the current DOM. The AI uses the MCP tools to explore the page and find the element, then returns a JSON with new selector and confidence score.

If confidence is above the user's threshold (default 0.85), the healer automatically patches the script in Postgres, marks the heal as auto-approved, and the test runner retries the failed test with the new selector. If below threshold, it stores the suggestion as pending and shows it in the Healer tab for manual review.

The Healer tab shows a table of all heal suggestions with confidence score badges, broken and suggested selectors, and Approve and Reject buttons. Approving patches the script. Rejecting keeps the broken state and flags the test case for manual investigation.

---

## Communication Between Frontend and Backend

The Next.js frontend talks to the Fastify backend entirely over HTTP and SSE. No WebSockets needed. SSE is simpler and perfectly sufficient for streaming logs and AI output.

All API calls from the frontend go through a single lib/api-client.ts file that prepends the NEXT_PUBLIC_API_URL environment variable. In development this is http://localhost:3001. In production it is the Render.com service URL.

CORS is configured on the Fastify backend to allow the Vercel frontend origin. Both origins (localhost:3000 for dev and the production Vercel URL) are whitelisted.

For AI streaming specifically, the Fastify backend uses the transfer-encoding chunked response and sets Content-Type to text/event-stream for the SSE routes.

---

## Environment Variables

Backend .env file needs: DATABASE_URL for Neon, UPSTASH_VECTOR_REST_URL and TOKEN, UPSTASH_REDIS_REST_URL and TOKEN, QSTASH_TOKEN and signing keys, R2_ACCOUNT_ID and keys and bucket name, ENCRYPTION_KEY as 32 bytes for AES.

Frontend .env.local needs: NEXT_PUBLIC_API_URL pointing to the backend.

AI provider keys are stored in the database encrypted, not in environment variables, because users enter them through the Model Connector UI.

---

## Build Order

Build in this exact sequence because each step depends on the previous one working correctly.

**Step 1:** Set up both repos. Initialize Next.js frontend. Initialize Fastify backend with TypeScript. Set up Drizzle with Neon, run migrations for all tables. Connect Upstash Vector and Redis clients. Configure Cloudflare R2 client. Set up CORS between frontend and backend. Verify the two services can talk to each other.

**Step 2:** Build document upload and ingestion end to end. Upload a real PDF, watch it process through QStash, verify vectors appear in Upstash Vector dashboard. This is the foundation everything else sits on.

**Step 3:** Build the Model Connector UI and the getModel adapter. Test every provider you plan to support. Verify switching models works correctly.

**Step 4:** Build test plan generation. This tests that RAG retrieval works and that streaming from Fastify to Next.js works correctly.

**Step 5:** Build test case generation. This tests that structured JSON output from the AI parses correctly and that the preview and save flow works.

**Step 6:** Build script generation without Playwright MCP first. Get the file tree and Monaco Editor working with static AI output. Then layer in the Playwright MCP integration.

**Step 7:** Build the test runner child process execution and SSE streaming. Get logs appearing in real time in the browser before touching the healer.

**Step 8:** Build the test healer once the runner is producing real failure data to heal against.

---

## What You Add Later

When you are ready to add auth, you drop Clerk in front of the existing routes with middleware. The user ID becomes a foreign key on every existing table. No existing logic changes, you just scope queries by user ID.

When you add project management, you add a projects table and a project ID foreign key to documents, test cases, scripts, and runs. The sidebar and project switcher sit on top of existing pages.

Everything is designed so the core works completely standalone and the future features are additive, not rewrites.