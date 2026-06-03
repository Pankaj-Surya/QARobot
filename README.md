# QA Robot

QA Robot is an AI-assisted QA platform for turning company knowledge into test plans, test cases, Playwright scripts, executable runs, reports, and validated healing suggestions. It is built around a RAG pipeline so product requirements, test plans, CSV test cases, API specs, PDFs, Markdown, Gherkin, and other source material can be ingested once and reused across QA workflows.

## Objective

QA teams often lose time moving between requirements, test design, automation, execution, debugging, and reporting. QA Robot connects those steps:

- Ingest QA/product knowledge into a retrieval pipeline.
- Ask questions against the ingested knowledge base.
- Generate test plans and test cases from retrieved evidence plus user scope.
- Generate simple Playwright scripts from saved or manual test cases.
- Run scripts through a local or cloud worker.
- Review logs, HTML reports, screenshots, traces, and video.
- Heal failed tests by generating fixes and validating them through the runner.

## Deployed App

- Frontend: [https://qarobot-frontend.vercel.app](https://qarobot-frontend.vercel.app)
- Backend health: [https://qarobot-backend.vercel.app/health](https://qarobot-backend.vercel.app/health)

The deployed frontend/backend run on Vercel. Browser execution does not run on Vercel; it requires the separate `qarobot-runner-worker` service.

## Architecture

```mermaid
flowchart LR
  User["User"] --> FE["Next.js Frontend"]
  FE --> API["Fastify Backend on Vercel"]
  API --> DB["Neon Postgres"]
  API --> Vector["Upstash Vector"]
  API --> Storage["Local / Cloudinary / R2 Storage"]
  API --> LLM["OpenAI-compatible / Groq / Ollama"]
  API --> Worker["Runner Worker"]
  Worker --> Browser["Playwright Browsers"]
  Worker --> Artifacts["HTML Report / Trace / Video / Screenshots"]
  Worker --> API
```

## Folder Structure

```text
QA Robot/
  README.md                         Main project guide
  docs/features/                    Feature guides
  qarobot-frontend/                 Next.js UI
  qarobot-backend/                  Fastify API, RAG, models, generation, storage
  qarobot-runner-worker/            Playwright execution and DOM inspection worker
  documents/                        Sample/reference documents
  .tools/cloudflared/               Optional local Cloudflare Tunnel executable
  guidance.md                       Historical testing guidance
  advanced_rag.md                   Historical RAG planning notes
  Plan.md                           Historical project plan
```

## Tech Stack

- Frontend: Next.js 14, React, TypeScript, Tailwind CSS, Lucide icons.
- Backend: Fastify, TypeScript, Drizzle ORM, Neon Postgres.
- RAG: document-aware chunking, Postgres chunk metadata, Upstash Vector, local embeddings/reranking.
- Storage: local filesystem for development, Cloudinary raw storage for deployed no-card storage, optional Cloudflare R2/S3-compatible storage.
- AI providers: OpenAI-compatible APIs, Groq, Ollama.
- Runner: separate Node/Fastify worker with Playwright.
- Deployment: Vercel for frontend/backend, separate local/VM/cloud worker for browser execution.

## Feature Guides

- [Dashboard](docs/features/dashboard.md)
- [Documents and RAG Pipeline](docs/features/documents-rag-pipeline.md)
- [Models](docs/features/models.md)
- [Test Plans](docs/features/test-plans.md)
- [Test Cases](docs/features/test-cases.md)
- [Test Scripts](docs/features/test-scripts.md)
- [Test Runner](docs/features/test-runner.md)
- [Test Healer](docs/features/test-healer.md)
- [Deployment](docs/features/deployment.md)
- [Environment and Storage](docs/features/environment-and-storage.md)

## Local Setup

### 1. Backend

```powershell
cd qarobot-backend
npm install
copy .env.example .env
npm.cmd run db:migrate
npm.cmd run dev
```

Backend health:

```text
http://localhost:3001/health
```

Minimum backend env:

```env
PORT="3001"
FRONTEND_ORIGIN="http://localhost:3000"
DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
DOCUMENT_STORAGE_DRIVER="local"
ENCRYPTION_KEY="base64-32-byte-encryption-key"
UPSTASH_VECTOR_REST_URL="https://example-vector.upstash.io"
UPSTASH_VECTOR_REST_TOKEN="upstash-vector-token"
```

### 2. Frontend

```powershell
cd qarobot-frontend
npm install
copy .env.example .env.local
npm.cmd run dev
```

Open:

```text
http://localhost:3000
```

For local frontend:

```env
NEXT_PUBLIC_API_URL="http://localhost:3001"
```

### 3. Runner Worker

```powershell
cd qarobot-runner-worker
npm install
npm run install:browsers
copy .env.example .env
npm run dev
```

Worker health:

```text
http://localhost:4001/health
```

In the Runner page, use:

```text
Worker URL: http://localhost:4001
Backend callback URL: http://localhost:3001
```

Click `Test and save`, then queue a run.

## Using The Deployed App

1. Open [https://qarobot-frontend.vercel.app](https://qarobot-frontend.vercel.app).
2. Configure model providers in Models.
3. Assign models in Feature Model Selection.
4. Upload documents in Documents and wait for ingestion.
5. Ask the RAG pipeline questions or generate test plans/cases.
6. Generate scripts from saved cases or manual text.
7. Connect a local or cloud runner worker before running scripts.
8. Review runner logs and artifacts.
9. Use Healer on failed runs and save only validated healed scripts.

## Runner With Cloudflare Tunnel

Use this when your deployed Vercel backend needs to reach a runner running on your local machine.

Start the worker:

```powershell
cd qarobot-runner-worker
npm run dev
```

Start a tunnel from the workspace root:

```powershell
.\.tools\cloudflared\cloudflared.exe tunnel --url http://localhost:4001
```

Or if `cloudflared` is installed globally:

```powershell
cloudflared tunnel --url http://localhost:4001
```

Use the generated HTTPS URL in Runner:

```text
Worker URL: https://your-temporary-name.trycloudflare.com
Backend callback URL: https://qarobot-backend.vercel.app
```

Temporary `trycloudflare.com` URLs change when the tunnel restarts. Paste the new URL and click `Test and save` again.

## Common Troubleshooting

- Failed to fetch on deployed frontend: verify `NEXT_PUBLIC_API_URL` was set at Vercel build time to `https://qarobot-backend.vercel.app`.
- Backend port already in use: run `netstat -ano | Select-String ':3001'`, then stop the PID.
- Runner does nothing: confirm the worker URL is saved, not only tested.
- Vercel runner cannot use `localhost:4001`: use Cloudflare Tunnel or deploy the worker to a public VM/service.
- Document upload fails in deployed app: confirm `DOCUMENT_STORAGE_DRIVER=cloudinary` and `CLOUDINARY_URL` are set in backend Vercel env.
- Model error: use Models -> Test connection, then assign the tested model to the feature.
- RAG says no data: rebuild ingestion, confirm chunks exist, and ask with filters matching ingested metadata.

## Verification Commands

```powershell
cd qarobot-backend
npm.cmd exec -- tsc -p tsconfig.json --noEmit

cd ..\qarobot-frontend
npm.cmd run typecheck
npm.cmd run build

cd ..\qarobot-runner-worker
npm.cmd exec -- tsc -p tsconfig.json --noEmit
```
