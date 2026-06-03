# Test Runner

## What

The Test Runner queues Playwright scripts to a separate worker, streams logs, and shows reports, screenshots, traces, and videos.

## Why

Vercel/serverless functions are not suitable for installing and running full browsers. QA Robot separates browser execution into a worker that can run locally or on a VM/cloud service.

## Main User Flow

1. Open Runner.
2. Select saved/local script or paste a script.
3. Connect worker.
4. Choose browser and headed/headless.
5. Queue runner job.
6. Watch logs.
7. Review HTML report, screenshots, trace, and video.

## Subfeatures Included

- Saved script runner.
- Pasted script runner.
- Worker connection test and save.
- Local runner.
- Cloud/VM runner.
- Headed/headless mode.
- Live logs.
- Run report table.
- HTML report artifacts.
- Screenshots.
- Trace zip.
- Video.
- Run history.

## How It Was Built

The frontend calls backend `/api/runs/start`. The backend creates a run row and sends a job to the saved runner worker URL. The worker executes Playwright, stores artifacts temporarily, and calls the backend with logs and final results.

## Tech Stack Used

- Next.js Runner page.
- Fastify run APIs.
- Postgres run history.
- Separate Fastify runner worker.
- Playwright.
- Cloudflare Tunnel for local public exposure.

## How The Tech Stack Is Used

The main backend queues and records runs. The worker owns browser execution, artifact generation, DOM inspection, and validation runs for Healer. Artifacts are served from temporary worker storage.

## Local Usage

Start worker:

```powershell
cd qarobot-runner-worker
npm install
npm run install:browsers
npm run dev
```

Use in Runner:

```text
Worker URL: http://localhost:4001
Backend callback URL: http://localhost:3001
```

Click `Test and save`, then queue a run.

## Deployed Usage With Cloudflare Tunnel

Start local worker:

```powershell
cd qarobot-runner-worker
npm run dev
```

If `.tools/cloudflared/cloudflared.exe` exists:

```powershell
cd "E:\AITesterProject2X\My_Learning\Projects\QA Robot"
.\.tools\cloudflared\cloudflared.exe tunnel --url http://localhost:4001
```

If installed globally:

```powershell
cloudflared tunnel --url http://localhost:4001
```

Use:

```text
Worker URL: https://your-name.trycloudflare.com
Backend callback URL: https://qarobot-backend.vercel.app
```

Click `Test and save`.

Temporary `trycloudflare.com` URLs change when the tunnel restarts.

## Installing Cloudflare Tunnel

Windows with winget:

```powershell
winget install --id Cloudflare.cloudflared
```

Windows manual workspace install:

```powershell
New-Item -ItemType Directory -Force -Path ".tools\cloudflared"
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile ".tools\cloudflared\cloudflared.exe"
.\.tools\cloudflared\cloudflared.exe --version
```

macOS:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:4001
```

Linux:

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:4001
```

## VM Setup

Generic VM/AWS/Azure:

```bash
git clone https://github.com/Pankaj-Surya/QARobot.git
cd QARobot/qarobot-runner-worker
npm install
npm run install:browsers
cp .env.example .env
npm run dev
```

Set:

```env
PORT="4001"
QA_ROBOT_CALLBACK_BASE_URL="https://qarobot-backend.vercel.app"
```

Expose port `4001` with HTTPS through a reverse proxy or platform domain. Save that public URL in Runner.

## Example

Pasted script:

```ts
import { test, expect } from "@playwright/test";

test("open app", async ({ page }) => {
  await page.goto("https://bstackdemo.com/");
  await expect(page).toHaveURL(/bstackdemo/);
});
```

## Troubleshooting

- If Run button is disabled, read the amber message above it.
- If Test connection passes but Run fails, click Test and save again.
- If Vercel cannot reach `localhost:4001`, use Cloudflare Tunnel or a VM.
- If headed mode is enabled, the visible browser opens on the worker machine, not inside Vercel.
- If artifacts are missing, run a new test after the artifact-generation update.

## Known Limitations

- Artifacts are temporary worker files, not database blobs.
- Live in-browser video requires a future VNC/noVNC worker stream.
- Protected sites may block browser automation.

## Interview Perspective Q&A

**Q: Why separate the runner from the backend?**  
A: Vercel/serverless is not designed for long-running browser execution or browser binaries.

**Q: How does the deployed backend reach a local worker?**  
A: Through a public tunnel like Cloudflare Tunnel.

**Q: Where are artifacts stored?**  
A: Temporarily on the worker machine and served through artifact URLs.

**Q: Why use callback URL?**  
A: The worker posts logs and final reports back to the backend run row.

