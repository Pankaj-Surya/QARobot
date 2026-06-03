# Models

## What

The Models feature stores provider configurations, tests live model connectivity, and assigns models to QA Robot features.

## Why

Different features need different model behavior. Document Chat, Test Plan Generator, Test Case Generator, Test Script Generator, and Test Healer can each use a selected model instead of relying on a confusing active-model fallback.

## Main User Flow

1. Open Models.
2. Configure provider, model name, task type, and credentials.
3. Save the model.
4. Test connection.
5. Assign tested models under Feature Model Selection.
6. Delete old or invalid models when no longer needed.

## Subfeatures Included

- Provider configuration.
- Encrypted API key storage.
- Ollama base URL support.
- Live test connection.
- Feature model selection.
- Delete model.
- Active model compatibility for older flows.
- Groq/OpenAI/Ollama generation support.

## How It Was Built

The backend stores model configs in Postgres. API keys are encrypted with `ENCRYPTION_KEY`. Feature assignments are stored separately so each feature can load its selected model. The model adapter supports OpenAI-compatible APIs, Groq, and Ollama.

## Tech Stack Used

- Fastify model APIs.
- Drizzle ORM and Postgres.
- Node crypto encryption helpers.
- OpenAI-compatible chat completions.
- Groq chat completions.
- Ollama local chat API.

## How The Tech Stack Is Used

The frontend posts model config to the backend. The backend encrypts secrets before saving. Test connection sends a tiny prompt and returns connected only when the provider accepts the credentials and model name.

## Local Usage

Open:

```text
http://localhost:3000/models
```

Generate an encryption key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add it to `qarobot-backend/.env`.

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/models
```

Configure providers in the UI. Secrets are stored in the deployed backend database, not in frontend code.

## Example

Groq model:

```text
Provider: Groq
Task: generation
Model: llama-3.3-70b-versatile
```

Then assign it to Test Case Generator or Document Chat.

## Troubleshooting

- If Groq returns model decommissioned, update the model name and test again.
- If no feature model is selected, the feature returns a clear missing-model message.
- If Ollama fails from Vercel, remember Vercel cannot reach your local Ollama unless exposed through a public URL.

## Known Limitations

- Anthropic and Google may be stored but are not wired unless adapters are added.
- Provider rate limits can block large prompts.
- Feature assignment requires an existing saved model.

## Interview Perspective Q&A

**Q: Why use feature-level model settings?**  
A: It avoids ambiguity and lets each workflow use the model best suited for that task.

**Q: How are API keys protected?**  
A: They are encrypted server-side before storage and never returned to the frontend.

**Q: Why test model connection before assignment?**  
A: It catches retired model names, bad keys, and unreachable base URLs before generation fails.

**Q: Why support Ollama?**  
A: It gives local/offline model flexibility for users who do not want cloud LLM calls.

