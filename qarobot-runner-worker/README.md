# QA Robot Runner Worker

This is the separate Playwright execution service for QA Robot. Install Playwright and browser binaries here, not in the main backend. The same worker supports both execution options:

- Local Machine Runner: run this service on your laptop for development.
- Cloud/VM Worker: deploy this service to a VM, Railway, Render, Fly.io, or another Docker-capable host for production.

## Local Machine Runner

From `qarobot-runner-worker`:

```bash
npm install
npm run install:browsers
copy .env.example .env
npm run dev
```

Start the backend and frontend, then open the Runner page. In `Connect Runner`, enter:

- Worker URL: `http://localhost:4001`
- Backend callback URL: `http://localhost:3001`

Click `Test connection`, then `Save connection`, then `Queue runner job`.

## Cloud/VM Worker

Deploy this folder as a separate service with Node.js 20+.

Set worker env:

```bash
PORT=4001
QA_ROBOT_CALLBACK_BASE_URL=https://your-backend-api.example.com
```

Open the Runner page in QA Robot. In `Connect Runner`, save your deployed worker URL and backend callback URL.

The main Vercel/API app creates queued runs and sends jobs to this worker. The worker executes Playwright and posts logs/results back to the backend.

## Endpoints

- `GET /health`
- `POST /runner/jobs`

The backend calls `POST /runner/jobs`; users normally do not call it directly.
