# QA Robot Backend

Fastify TypeScript backend for QA Robot.

For the full project guide, architecture, deployed usage, and feature documentation, see the root [README.md](../README.md).

## Prerequisites

- Node.js 20 or newer.
- A Neon PostgreSQL database URL.
- Local document storage is the default for development.
- Cloudinary raw storage is supported for deployed no-card document storage.
- Cloudflare R2/S3-compatible storage can be enabled later.

## Environment Setup

Create `qarobot-backend/.env` and add the values below.

```bash
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"

FRONTEND_ORIGIN="http://localhost:3000"
PORT="3001"

# Local document storage is used by default.
DOCUMENT_STORAGE_DRIVER="local"
LOCAL_DOCUMENT_STORAGE_DIR="documents"

# Required before saving model provider API keys.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY="paste-generated-32-byte-base64-key-here"

# Needed later for RAG caching and async jobs.
UPSTASH_VECTOR_REST_URL="https://your-vector-index.upstash.io"
UPSTASH_VECTOR_REST_TOKEN="your-upstash-vector-token"
UPSTASH_REDIS_REST_URL="https://your-redis-instance.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-redis-token"
QSTASH_TOKEN="your-qstash-token"
QSTASH_CURRENT_SIGNING_KEY="your-current-qstash-signing-key"
QSTASH_NEXT_SIGNING_KEY="your-next-qstash-signing-key"

# Add these later when Cloudflare R2 is available.
# DOCUMENT_STORAGE_DRIVER="r2"
# R2_ACCOUNT_ID="your-cloudflare-account-id"
# R2_ACCESS_KEY_ID="your-r2-access-key-id"
# R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
# R2_BUCKET_NAME="your-r2-bucket-name"

# Use Cloudinary for deployed no-card raw document storage.
# DOCUMENT_STORAGE_DRIVER="cloudinary"
# CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
```

Where to get the values:

- `DATABASE_URL`: Neon dashboard, from the database connection string.
- `ENCRYPTION_KEY`: run this command from any terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN`: create an Upstash Vector index, then copy the REST URL and REST token from that index's Connect or Details page.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: create an Upstash Redis database, then copy the REST URL and REST token from the database Connect or Details page.
- `QSTASH_TOKEN`: open Upstash QStash in the Upstash Console and copy the token from the QStash settings or tokens page.
- `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`: open Upstash QStash signing keys and copy the current and next signing keys. These are used to verify QStash callback requests.
- `R2_ACCOUNT_ID`: Cloudflare dashboard account ID. Add this only after R2 is enabled.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: Cloudflare R2 S3-compatible access keys. Add these only after R2 is enabled.
- `R2_BUCKET_NAME`: the exact bucket name created in Cloudflare R2. Add this only after R2 is enabled.

Keep `.env` local. It is intentionally ignored by git.

## Storage Mode

The backend currently supports local, Cloudinary, and optional R2 document storage modes.

Local mode is the default and needs no payment card:

```bash
DOCUMENT_STORAGE_DRIVER="local"
LOCAL_DOCUMENT_STORAGE_DIR="documents"
```

Uploaded files are saved under `qarobot-backend/documents/`. This folder is ignored by git.

Cloudinary mode can be used for deployed storage without Cloudflare R2:

```bash
DOCUMENT_STORAGE_DRIVER="cloudinary"
CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
```

R2 mode can be enabled later:

```bash
DOCUMENT_STORAGE_DRIVER="r2"
R2_ACCOUNT_ID="your-cloudflare-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
R2_BUCKET_NAME="your-r2-bucket-name"
```

## Install

```bash
npm install
```

## Create Database Tables

After `DATABASE_URL` is set, run the Drizzle migration:

```bash
npm.cmd run db:migrate
```

Use `npm run db:migrate` on non-Windows shells.

## Run

```bash
npm.cmd run dev
```

The backend should start on:

```text
http://localhost:3001
```

When it starts successfully, the terminal stays open and shows a log like:

```text
Server listening at http://0.0.0.0:3001
```

That is normal. Keep that terminal running while using the app.

Health check:

```text
http://localhost:3001/health
```

## Test Runner Execution

The backend is Vercel-safe: it does not install Playwright browsers and does not execute browser tests directly. To run generated scripts, use one of these separate runner options.

### Option 1: Local Machine Runner

Best for development on your own machine.

1. Open a new terminal in `qarobot-runner-worker`.
2. Install the worker and browser binaries:

```bash
npm install
npm run install:browsers
```

3. Start the worker:

```bash
npm run dev
```

4. Open the Runner page in QA Robot.
5. In `Connect Runner`, set `Worker URL` to `http://localhost:4001` and `Backend callback URL` to `http://localhost:3001`.
6. Click `Test connection`, then `Save connection`.

### Option 2: Cloud/VM Worker

Best for production when the main app/API is on Vercel.

1. Deploy `qarobot-runner-worker` to a VM, Railway, Render, Fly.io, or another Node.js service that can install Playwright browsers.
2. Set the worker env:

```bash
PORT="4001"
QA_ROBOT_CALLBACK_BASE_URL="https://your-backend-api.example.com"
```

3. Open the Runner page in QA Robot.
4. Save `Worker URL` as your deployed worker URL.
5. Save `Backend callback URL` as your backend/API URL.

The backend queues the run, sends it to `POST /runner/jobs` on the saved worker URL, and the worker posts logs/results back to the saved backend callback URL. Environment variables remain available only as fallback for advanced deployments.

## Backend Startup Troubleshooting

If you see `EADDRINUSE: address already in use 0.0.0.0:3001`, another backend process is already running.

Find it:

```powershell
netstat -ano | Select-String ':3001'
```

Stop the PID from the last column:

```powershell
Stop-Process -Id <PID> -Force
```

Then run the backend again:

```bash
npm.cmd run dev
```

If you want file watching/restart behavior, use:

```bash
npm.cmd run dev:watch
```

## End-to-End Document Upload Test

1. Start the backend:

```bash
npm.cmd run dev
```

2. In a second terminal, start the frontend from `qarobot-frontend`:

```bash
npm.cmd run dev
```

3. Open the Documents page:

```text
http://localhost:3000/documents
```

4. Upload a sample PDF, TXT, CSV, Markdown, JSON, YAML, or Gherkin file.

5. The frontend sends the file to `POST /api/documents/upload`. In local mode, the backend saves it under `qarobot-backend/documents/` and inserts a `documents` row with `processing` status.

6. The frontend then calls `POST /api/documents/process`. The backend reads the stored file, extracts text, chunks it, stores chunk rows in `document_chunks`, and marks the document as `indexed`.

7. Confirm the document appears in the table with `indexed` status and a non-zero chunk count.

## Useful Commands

```bash
npm.cmd run build
npm.cmd run db:generate
npm.cmd run db:migrate
```

The database schema is in `src/db/schema.ts`.


If this happens again, quick check:

netstat -ano | Select-String ':3001'
Then stop the PID shown in the last column:

Stop-Process -Id <PID> -Force
