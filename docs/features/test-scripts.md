# Test Scripts

## What

The Test Scripts feature generates simple Playwright scripts from saved test cases or manual testcase text and a mandatory app URL.

## Why

Test cases are useful only when they can move toward automation. QA Robot generates simple Playwright specs that can be run, debugged, and healed.

## Main User Flow

1. Open Scripts.
2. Enter the app URL.
3. Choose saved test cases or manual testcase text.
4. Choose generation mode.
5. Test configuration.
6. Generate script.
7. Use the local generated script in Runner.

## Subfeatures Included

- Mandatory app URL.
- Saved testcase input.
- Manual testcase textarea.
- Generation modes:
  - LLM + DOM inspection
  - LLM only
  - deterministic + DOM inspection
  - deterministic only
- Runner-worker DOM inspection.
- Simple Playwright spec output.
- Temporary local generated script.
- Config test before generation.

## How It Was Built

The backend builds testcase context, optionally asks the runner worker to inspect the app DOM, and then either prompts the selected Test Script Generator model or uses deterministic mapping rules. Output remains a simple Playwright spec with no page objects.

## Tech Stack Used

- Fastify scripts API.
- Playwright DOM inspection through runner worker.
- Feature model adapter.
- Next.js Scripts page.
- Browser role/text/placeholder selectors.

## How The Tech Stack Is Used

The runner worker opens the app and collects DOM signals. The backend uses those signals to choose selectors. Generated scripts are kept temporary in frontend local storage for Runner/Healer flow unless saved through explicit flows.

## Local Usage

Open:

```text
http://localhost:3000/scripts
```

Start runner worker first for DOM modes:

```powershell
cd qarobot-runner-worker
npm run dev
```

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app/scripts
```

For DOM inspection from deployed backend, the worker URL must be public through Cloudflare Tunnel or a deployed worker.

## Example

Manual testcase:

```text
TC: Verify Search Product
1. Launch App
2. Click Sign In button
3. Select Username
4. Select password
5. Click Login button
6. Search "iPhone"
7. User should see matching product
```

Expected output is a single Playwright spec using direct commands such as `page.goto`, `getByRole`, `getByText`, `getByPlaceholder`, and `expect`.

## Troubleshooting

- If LLM mode fails with token limits, use LLM only or deterministic DOM mode.
- If DOM inspection fails on protected sites, use deterministic only or a staging URL that allows automation.
- If selectors are weak, run the script and use Test Healer on failures.
- If saved cases are missing, click Save in Test Case Generator first.

## Known Limitations

- Some sites block automated inspection.
- Auth/CAPTCHA flows need future auth-state support.
- Generated scripts are intentionally simple, not full automation frameworks.

## Interview Perspective Q&A

**Q: Why require App URL?**  
A: Script generation needs the target app to set `baseURL` and optionally inspect DOM selectors.

**Q: Why avoid page objects?**  
A: The product goal is fast, readable, simple scripts that users can run and heal quickly.

**Q: Why provide deterministic modes?**  
A: They allow generation without an LLM or when provider limits fail.

**Q: Why use the worker for DOM inspection?**  
A: The main backend is Vercel-safe and should not launch browsers.

