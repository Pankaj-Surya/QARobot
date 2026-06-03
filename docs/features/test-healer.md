# Test Healer

## What

The Test Healer analyzes failed Playwright runs, classifies the failure, generates a minimal fix, validates the fix through the runner worker, and only marks it healed when validation passes.

## Why

Unvalidated AI fixes are risky. QA Robot improves trust by rerunning candidate fixes and showing proof before saving a healed script.

## Main User Flow

1. Run a script and let it fail.
2. Open Healer.
3. Select the failed run.
4. Click Analyze, fix, and validate.
5. Review attempts.
6. If healed, save the script or run it again.
7. Run healed script navigates to Runner.

## Subfeatures Included

- Failed run discovery.
- Failure classification.
- DOM inspection through runner worker.
- Deterministic repair.
- LLM repair through Test Healer model.
- Validation attempts.
- Artifacts per validation attempt.
- Save healed script.
- Run healed script and navigate to Runner.

## How It Was Built

The backend loads the failed run, source spec, logs, test errors, and artifacts. It classifies the failure and generates candidate fixes. Each candidate is sent to the worker validation endpoint. Only a passing validation returns final status `healed`.

## Tech Stack Used

- Fastify healer APIs.
- Postgres run results and script rows.
- Runner worker validation endpoint.
- Playwright validation runs.
- Feature model adapter for Test Healer.
- Next.js Healer page.

## How The Tech Stack Is Used

The worker executes temporary validation scripts and returns reports/artifacts directly. The backend compares result status and retry attempts. The UI exposes save/run only after validation passes.

## Local Usage

1. Start backend, frontend, and worker.
2. Run a failing script from Runner.
3. Open:

```text
http://localhost:3000/healer
```

4. Analyze and validate the failed run.

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/healer
```

The runner worker must be connected with a public URL if the backend is deployed.

## Example

Failure:

```text
expect(locator).toBeVisible failed
Locator: getByText(/iphone in product list/i)
```

Expected healer behavior:

- Classify as selector/assertion issue.
- Inspect DOM.
- Generate fix candidate.
- Run validation.
- Mark healed only if validation passes.

## Troubleshooting

- If no failed runs appear, create a failed run from Runner.
- If no source spec exists, rerun the script after the latest runner update.
- If validation fails repeatedly, inspect artifacts and manual review hints.
- If no model is selected, deterministic repair still runs but may be limited.

## Known Limitations

- It cannot guarantee fixes for app outages, CAPTCHA, auth setup, missing test data, or changed business rules.
- Validation depends on worker connectivity.
- Some failures need human review.

## Interview Perspective Q&A

**Q: Why validate healed scripts?**  
A: Validation prevents the app from presenting unproven AI suggestions as successful fixes.

**Q: What is the difference between deterministic and LLM repair?**  
A: Deterministic repair handles common known patterns; LLM repair uses broader context and prior failed attempts.

**Q: Why classify failures first?**  
A: Classification prevents wrong fixes, such as changing selectors when the app is actually unavailable.

**Q: Why not overwrite the original script automatically?**  
A: The original should remain traceable. Users save a validated healed version explicitly.

