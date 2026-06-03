# Environment And Storage

## What

This guide explains environment variables, where to get them, document storage options, and how to stop services to avoid usage/billing.

## Why

QA Robot depends on database, vector search, storage, model providers, and optional worker services. Clear env setup prevents confusing runtime failures.

## Main User Flow

1. Create required accounts/services.
2. Copy env values into backend/frontend/worker env files or Vercel env.
3. Run migrations.
4. Start services.
5. Stop or pause services when not working.

## Subfeatures Included

- Neon `DATABASE_URL`.
- Upstash Vector.
- Upstash Redis/QStash placeholders.
- Encryption key generation.
- Local storage.
- Cloudinary storage.
- Future R2/S3 storage.
- Runner env.
- Billing/off switch notes.

## How It Was Built

The backend reads env values from `.env` locally and Vercel env in deployment. Storage driver selection is controlled by `DOCUMENT_STORAGE_DRIVER`. Secrets remain out of git.

## Tech Stack Used

- dotenv-style local env files.
- Neon Postgres.
- Upstash Vector.
- Cloudinary raw resources.
- Optional Cloudflare R2.
- Vercel env vars.

## Backend Env

```env
PORT="3001"
FRONTEND_ORIGIN="http://localhost:3000"
DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
DOCUMENT_STORAGE_DRIVER="local"
CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
UPSTASH_VECTOR_REST_URL="https://example-vector.upstash.io"
UPSTASH_VECTOR_REST_TOKEN="upstash-vector-token"
ENCRYPTION_KEY="base64-32-byte-encryption-key"
RUNNER_MODE="disabled"
RUNNER_WORKER_URL="http://localhost:4001"
PUBLIC_BACKEND_URL="http://localhost:3001"
```

## Frontend Env

```env
NEXT_PUBLIC_API_URL="http://localhost:3001"
```

For deployed frontend:

```env
NEXT_PUBLIC_API_URL="https://qarobot-backend.vercel.app"
```

## Runner Env

```env
PORT="4001"
RUNNER_WORK_DIR=".runner-work"
QA_ROBOT_CALLBACK_BASE_URL="http://localhost:3001"
```

For deployed backend callback:

```env
QA_ROBOT_CALLBACK_BASE_URL="https://qarobot-backend.vercel.app"
```

## Where To Get Values

- `DATABASE_URL`: Neon dashboard connection string.
- `ENCRYPTION_KEY`: run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `UPSTASH_VECTOR_REST_URL` and token: Upstash Vector index details.
- `CLOUDINARY_URL`: Cloudinary dashboard API environment variable.
- Model API keys: provider dashboard such as Groq or OpenAI.
- R2 values: Cloudflare R2 dashboard after R2 is enabled.

## Storage Modes

Local:

```env
DOCUMENT_STORAGE_DRIVER="local"
```

Cloudinary:

```env
DOCUMENT_STORAGE_DRIVER="cloudinary"
CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
```

Future R2:

```env
DOCUMENT_STORAGE_DRIVER="r2"
R2_ACCOUNT_ID="..."
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
R2_BUCKET_NAME="..."
```

## Billing / Stop Services

- Stop local backend/frontend/worker terminals when not working.
- Stop Cloudflare Tunnel terminal when not running local worker.
- Pause or delete unused Neon/Upstash/Cloudinary resources if needed.
- Remove Vercel env secrets if a deployment should no longer access services.
- For model providers, remove API keys from Models or provider dashboard if you want to stop usage.

## Troubleshooting

- If `.env.example` contains real secrets, rotate them and replace with dummy values.
- If migration fails, verify `DATABASE_URL`.
- If upload fails on Vercel, use Cloudinary or R2, not local storage.
- If vectors fail, check Upstash URL/token.

## Known Limitations

- Local storage is not durable on Vercel.
- Cloudinary is used as a temporary no-card storage option.
- Upstash/Neon free tiers may have limits.

## Interview Perspective Q&A

**Q: Why separate `.env.example` from `.env`?**  
A: `.env.example` documents required keys without exposing secrets.

**Q: Why use `ENCRYPTION_KEY`?**  
A: It encrypts stored provider API keys before they are written to the database.

**Q: Why not use local storage in Vercel?**  
A: Serverless filesystems are ephemeral and not reliable for uploaded documents.

**Q: How do you stop billing risk?**  
A: Stop local services, remove API keys, pause external resources, and avoid running worker/tunnels when not needed.

