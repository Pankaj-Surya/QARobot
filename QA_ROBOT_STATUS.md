# QA Robot Status

Last updated: 2026-05-26

## Requirement Target

- Frontend: Next.js 14 with TypeScript, Tailwind CSS, Vercel deployment.
- Backend: separate Node.js Fastify TypeScript service, deployed as a persistent Render.com service.
- Storage and data services: Neon PostgreSQL with Drizzle, Upstash Vector, Upstash Redis/QStash, Cloudflare R2.
- Test automation: Playwright MCP integrated in the backend for script generation and healing.

## Current Repository Audit

- This folder is currently a React Router/Vite app, not a Next.js 14 app.
- Evidence: `package.json` uses `react-router dev`, and the repo contains `vite.config.ts`, `react-router.config.ts`, `.react-router`, and React Router dependencies.
- There is no separate Fastify backend repo or service in this workspace.
- Existing API routes are embedded under `src/app/api` and are wired through Hono/React Router infrastructure, not Fastify.
- The current API routes are mostly simple CRUD endpoints backed by Neon SQL helper code. They do not implement the planned RAG pipeline, QStash processing, Upstash Vector indexing, R2 storage, AI streaming, Playwright MCP, SSE run logs, or healing workflow.

## Cleanup Completed

- Removed the direct external upload call to the old builder storage endpoint from `src/app/api/utils/upload.js`.
- Changed `src/app/api/documents/upload/route.js` so uploads now fail clearly with HTTP 501 until the required Cloudflare R2 storage layer exists.
- Removed explicit old builder-domain allowlist references from `src/__create/fetch.ts`.
- Removed the old builder project token value from `.env` and replaced it with the intended frontend API URL placeholder.
- Added `.env` and `.env.local` to `.gitignore` so local secrets are not tracked going forward.

## Verified Gaps Against Build Order

- Step 1 is not complete: the repo has not been split into `qarobot-frontend` and `qarobot-backend`.
- Step 1 is not complete: Next.js 14 frontend is not initialized.
- Step 1 is not complete: Fastify backend with TypeScript is not initialized.
- Step 1 is not complete: Drizzle schema and migrations are not present.
- Step 1 is not complete: R2, Upstash Vector, Redis, QStash, and CORS between separate services are not implemented.
- Steps 2 through 8 are not complete because their foundation is missing.

## Verification Performed

- Searched source/config files for old Anything-domain and token references; no remaining matches were found outside ignored dependency/lock files.
- Ran `npm.cmd run typecheck`; it fails on pre-existing React Router generated typings and JSX module declaration issues across the builder app. The failure is not caused by the storage cleanup.
- Checked Git status, but this folder is not currently inside a Git repository.

## Recommended Next Work

1. Create `qarobot-frontend` as a real Next.js 14 TypeScript app.
2. Create `qarobot-backend` as a Fastify TypeScript app.
3. Move only useful UI ideas from this builder app into the Next.js frontend.
4. Implement the database schema in Drizzle migrations before rebuilding document upload.
