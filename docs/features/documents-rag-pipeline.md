# Documents And RAG Pipeline

## What

The Documents feature uploads source material, stores the original file, ingests it into chunks, writes metadata to Postgres, stores vectors in Upstash Vector, and lets the user ask questions against the full ingested knowledge base.

## Why

QA teams need answers and generated outputs grounded in company data, not generic model guesses. The RAG pipeline makes uploaded PRDs, test plans, CSV test cases, Gherkin files, PDFs, API specs, and notes reusable across chat, test plan generation, and test case generation.

## Main User Flow

1. Open Documents.
2. Upload a source file.
3. Wait for ingestion to complete.
4. Ask a question in Ask RAG Pipeline.
5. Review the answer and optional retrieval details.
6. Rebuild ingestion if source parsing or vectors need to be refreshed.
7. Delete one or all uploaded sources when they should no longer be searchable.

## Subfeatures Included

- Upload documents.
- Local, Cloudinary, and optional R2 storage drivers.
- Automatic ingestion after upload.
- Document-aware chunking.
- Dynamic metadata extraction.
- Upstash Vector indexing.
- Hybrid retrieval and reranking.
- RAG chat across the full knowledge base.
- Rebuild ingestion from stored files.
- Delete individual documents.
- Delete all uploaded documents.

## How It Was Built

The backend stores document rows and chunk rows in Postgres. File storage is abstracted so local storage works during development and Cloudinary works in deployed environments. Ingestion parses each document type into meaningful chunks before embeddings are generated and upserted to Upstash Vector. Retrieval combines structured metadata, lexical matching, vector search, and reranking before handing evidence to the selected LLM.

## Tech Stack Used

- Fastify for document APIs.
- Drizzle ORM and Neon Postgres for documents and chunks.
- Upstash Vector for semantic retrieval.
- Local embedding/reranker models for free semantic search support.
- Cloudinary raw storage for deployed document files.
- OpenAI-compatible/Groq/Ollama generation through model adapters.

## How The Tech Stack Is Used

Fastify receives uploads, stores files, creates document rows, and starts ingestion. Postgres remains the source of truth for chunks and metadata. Upstash Vector stores vector ids linked to chunk rows. The LLM is used only after retrieval validates evidence.

## Local Usage

```powershell
cd qarobot-backend
npm.cmd run dev

cd ..\qarobot-frontend
npm.cmd run dev
```

Open:

```text
http://localhost:3000/documents
```

Upload a `.txt`, `.md`, `.csv`, `.json`, `.yaml`, `.feature`, `.pdf`, or similar supported file.

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/documents
```

Backend Vercel env should include:

```env
DOCUMENT_STORAGE_DRIVER="cloudinary"
CLOUDINARY_URL="cloudinary://api_key:api_secret@cloud_name"
DATABASE_URL="postgresql://..."
UPSTASH_VECTOR_REST_URL="https://..."
UPSTASH_VECTOR_REST_TOKEN="..."
ENCRYPTION_KEY="..."
```

## Example

Question:

```text
give me login related testcases with Priority - High
```

Expected behavior:

- Query parser treats `-` as a separator.
- Retrieval dynamically matches metadata fields such as Priority, Severity, Module, Component, or custom CSV columns.
- Answer returns complete matching test case rows, not partial chunks.

## Troubleshooting

- If upload fails, check backend storage env and CORS.
- If answers are missing known data, rebuild ingestion.
- If CSV rows look partial, confirm the file was reprocessed after multiline CSV parser fixes.
- If chat says no model selected, assign Document Chat model in Models.
- If deployed frontend says Failed to fetch, confirm `NEXT_PUBLIC_API_URL` was baked into the frontend deployment.

## Known Limitations

- Quality depends on uploaded source quality and successful ingestion.
- Very large documents may need chunk tuning.
- Cloudinary is temporary no-card storage; R2/S3 can be used later.

## Interview Perspective Q&A

**Q: Why use RAG instead of sending all documents to the LLM?**  
A: RAG keeps prompts small, grounded, cheaper, and more accurate by retrieving only relevant evidence.

**Q: Why keep Postgres chunks if vectors exist?**  
A: Postgres is the source of truth for metadata, deletion, filtering, and preventing stale vector results.

**Q: How does the pipeline support dynamic filters?**  
A: It stores original fields and normalized metadata from headers/sections, then query parsing matches filters against available fields rather than hardcoded columns.

**Q: Why rebuild ingestion?**  
A: Rebuild clears old chunks/vectors and reprocesses stored files after parser, metadata, or embedding improvements.

