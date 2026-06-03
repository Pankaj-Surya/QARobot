# Test Plans

## What

The Test Plans feature generates QA test plans from a user-provided scope plus retrieved evidence from the RAG pipeline.

## Why

Manual test plan creation is slow and often disconnected from source requirements. QA Robot grounds the generated plan in ingested knowledge while still using the user scope as the primary requirement.

## Main User Flow

1. Open Plans.
2. Enter plan name and scope.
3. Generate a plan.
4. Review the Markdown output.
5. Use assumptions and missing areas when retrieval evidence is weak.

## Subfeatures Included

- Scope-based generation.
- Full RAG retrieval without document selection.
- Feature model assignment for Test Plan Generator.
- Standard QA plan structure.
- Missing requirement/assumption handling.

## How It Was Built

The backend accepts scope input, retrieves relevant chunks from the full ingested knowledge base, and sends scope plus evidence to the selected planning model. The output is Markdown using a stable test plan structure.

## Tech Stack Used

- Fastify test plan API.
- RAG retrieval services.
- Feature model adapter.
- Postgres for saved plan rows.
- Next.js Plans page.

## How The Tech Stack Is Used

Postgres stores generated plans. Retrieval uses ingested chunks and vector/metadata search. The LLM writes the plan only after receiving the scope and retrieved evidence.

## Local Usage

Open:

```text
http://localhost:3000/test-plans
```

Make sure a Test Plan Generator model is assigned in Models.

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/test-plans
```

Upload and ingest source documents first for best results.

## Example

Scope:

```text
Create a test plan for SSO login across Google and Microsoft domains.
```

Expected sections:

- Title
- Scope
- Objective
- Source Requirement Summary
- In Scope
- Out Of Scope
- Test Strategy
- Test Scenario Matrix
- Test Data
- Entry Criteria
- Exit Criteria
- Risks

## Troubleshooting

- If generation fails, test the assigned model.
- If the plan is too generic, upload/rebuild relevant requirements.
- If evidence is weak, the plan should mark assumptions instead of inventing facts.

## Known Limitations

- Plan quality depends on the scope and ingested evidence.
- It does not execute tests.
- It does not replace review by QA leads.

## Interview Perspective Q&A

**Q: Why is scope still required if RAG exists?**  
A: Scope defines the user's intent; RAG provides grounding and supporting evidence.

**Q: How does it avoid unrelated documents?**  
A: Retrieval ranks evidence by lexical, metadata, vector, and rerank signals before the LLM sees it.

**Q: Why output Markdown?**  
A: Markdown is readable, copyable, and easy to render in the UI.

**Q: What happens when evidence is weak?**  
A: The prompt requires assumptions and missing areas rather than fabricated requirements.

