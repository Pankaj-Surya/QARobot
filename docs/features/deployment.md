# Deployment

## What

QA Robot uses Vercel for the frontend/backend and a separate worker for Playwright execution.

## Why

The frontend and API are serverless-friendly. Browser execution is not, so it runs in `qarobot-runner-worker` on a local machine, VM, or cloud app service.

## Main Deployment Flow

1. Deploy `qarobot-backend` to Vercel.
2. Deploy `qarobot-frontend` to Vercel.
3. Configure frontend build-time API URL.
4. Configure backend env values.
5. Deploy or expose the runner worker.
6. Save worker connection in Runner.

## Subfeatures Included

- Vercel frontend.
- Vercel backend API.
- Cloudinary document storage.
- Neon database.
- Upstash Vector.
- Model provider configuration.
- Separate worker deployment.
- Cloudflare Tunnel for local worker.

## How It Was Built

The backend has a Vercel API entrypoint that adapts Fastify to Vercel. The frontend uses `NEXT_PUBLIC_API_URL` at build time. Runner worker is a separate Node service and should not be deployed as a Vercel serverless function.

## Tech Stack Used

- Vercel.
- Next.js.
- Fastify with `@vercel/node`.
- Neon Postgres.
- Cloudinary.
- Upstash Vector.
- Playwright worker on VM/local/cloud.

## How The Tech Stack Is Used

Vercel serves UI and API. Neon stores data. Cloudinary stores uploaded source files. Upstash Vector stores embeddings. Worker executes Playwright jobs.

## Backend Vercel Env

```env
DATABASE_URL="postgresql://..."
FRONTEND_ORIGIN="https://qarobot-frontend.vercel.app"
DOCUMENT_STORAGE_DRIVER="cloudinary"
CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
UPSTASH_VECTOR_REST_URL="https://..."
UPSTASH_VECTOR_REST_TOKEN="..."
ENCRYPTION_KEY="base64-32-byte-key"
```

## Frontend Vercel Env

Set at build time:

```env
NEXT_PUBLIC_API_URL="https://qarobot-backend.vercel.app"
```

Deploy command example:

```powershell
cd qarobot-frontend
npm.cmd exec --package vercel -- vercel deploy --prod --yes -b NEXT_PUBLIC_API_URL=https://qarobot-backend.vercel.app -e NEXT_PUBLIC_API_URL=https://qarobot-backend.vercel.app
```

## Worker Deployment

The worker can run on:

- local machine with Cloudflare Tunnel
- AWS VM
- Azure VM
- Railway
- Render
- Fly.io
- Docker-capable service

Worker env:

```env
PORT="4001"
QA_ROBOT_CALLBACK_BASE_URL="https://qarobot-backend.vercel.app"
```

## Example Deployed Usage

```text
Frontend: https://qarobot-frontend.vercel.app
Backend callback URL: https://qarobot-backend.vercel.app
Worker URL: https://your-worker-domain.example.com
```

## Troubleshooting

- If deployed pages say Failed to fetch, check frontend build-time env.
- If uploads fail, check Cloudinary env on backend project.
- If runner fails, check worker URL is public and health endpoint works.
- If model calls fail, test model connection in Models.

## Known Limitations

- Vercel backend cannot use local filesystem as durable document storage.
- Vercel backend cannot execute Playwright browsers directly.
- Temporary tunnels are not permanent production worker URLs.

## Interview Perspective Q&A

**Q: Why split backend and runner?**  
A: It keeps the API Vercel-safe while allowing browser execution where browsers can be installed.

**Q: Why must `NEXT_PUBLIC_API_URL` be build-time?**  
A: Next.js public env variables are embedded in the client bundle during build.

**Q: Why Cloudinary?**  
A: It provides no-card raw file storage while R2 is unavailable.

**Q: What is the production runner pattern?**  
A: Deploy a persistent worker service and save its public URL in Runner.

