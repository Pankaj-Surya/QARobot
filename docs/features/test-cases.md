# Test Cases

## What

The Test Cases feature generates structured test cases from a requirement or feature description, using RAG evidence as context and examples.

## Why

QA teams need fast, consistent test case design. QA Robot helps turn requirements into saved test cases that can later feed script generation.

## Main User Flow

1. Open Cases.
2. Enter a feature description.
3. Choose count and mode.
4. Generate test cases.
5. Review draft cases.
6. Click Save to persist them.
7. Use saved cases in Test Script Generator.

## Subfeatures Included

- Requirement-based generation.
- RAG retrieval across the full knowledge base.
- JSON schema enforcement.
- Parser tolerance and JSON repair.
- Save generated cases.
- Saved cases listed in Script Generator.
- Jira-style table rendering.

## How It Was Built

The backend retrieves evidence, prompts the selected Test Case Generator model, validates JSON, normalizes common LLM variations, and saves accepted cases to Postgres only when the user clicks Save.

## Tech Stack Used

- Fastify test case APIs.
- RAG retrieval service.
- Feature model adapter.
- Zod/normalization-style schema handling.
- Postgres test case table.
- Next.js Cases page.

## How The Tech Stack Is Used

The LLM outputs a JSON wrapper with cases. The backend repairs common shape issues, validates fields, and returns draft cases. Saving writes rows to Postgres so other features can use them.

## Local Usage

Open:

```text
http://localhost:3000/test-cases
```

Assign a Test Case Generator model in Models.

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/test-cases
```

Save generated cases before expecting them in Test Script Generator.

## Example

Feature description:

```text
SSO login should disable password for Google and Microsoft domains and keep password login enabled for non-configured domains.
```

Expected cases include:

- Google domain disables password and shows Google icon.
- Microsoft domain disables password and shows Microsoft icon.
- Provider sign-in opens SSO screen.
- Non-configured domain keeps password login enabled.
- Domain changes switch login mode.
- Blank/malformed username does not trigger SSO mode.

## Troubleshooting

- If JSON is invalid, the backend attempts repair.
- If save does not show in Script Generator, confirm `/api/test-cases?limit=20` returns newest saved rows.
- If results are unrelated, rebuild ingestion and confirm retrieval evidence.

## Known Limitations

- Generated cases should be reviewed before automation.
- Very ambiguous feature descriptions can produce broad cases.
- Saved cases are independent of generated drafts until Save is clicked.

## Interview Perspective Q&A

**Q: Why validate JSON from the LLM?**  
A: LLM output can vary; validation prevents malformed data from entering saved test cases.

**Q: Why keep drafts separate from saved cases?**  
A: Users can review before persisting. Script Generator uses only backend-saved cases.

**Q: How does RAG help test cases?**  
A: It provides domain examples, constraints, and historical test coverage.

**Q: Why normalize LLM variations?**  
A: It reduces failures from harmless shape differences like `step` versus `steps`.

