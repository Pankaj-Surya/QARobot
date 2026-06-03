# Dashboard

## What

The Dashboard is the landing view for QA Robot. It gives users a quick way to understand the available QA workflows and navigate to the feature they need.

## Why

QA Robot has multiple connected capabilities: documents, models, plans, cases, scripts, runner, and healer. A dashboard helps users start in the right place without memorizing the workflow.

## Main User Flow

1. Open QA Robot.
2. Review available modules.
3. Navigate to Documents, Models, Plans, Cases, Scripts, Runner, or Healer.
4. Follow the end-to-end QA flow from ingestion to healing.

## Subfeatures Included

- App landing page.
- Feature navigation cards.
- Sidebar navigation.
- Short descriptions for core workflows.

## How It Was Built

The dashboard is a Next.js app route rendered by the frontend. It uses the shared app shell and navigation structure so every feature remains reachable from one layout.

## Tech Stack Used

- Next.js App Router.
- React.
- Tailwind CSS.
- Lucide icons.

## How The Tech Stack Is Used

Next.js provides the route, React renders feature cards/navigation, Tailwind handles layout/styling, and Lucide provides consistent icons.

## Local Usage

Open:

```text
http://localhost:3000
```

## Deployed Usage

Open:

```text
https://qarobot-frontend.vercel.app
```

## Example

Start from Dashboard, then:

```text
Documents -> upload source material -> Models -> assign model -> Cases -> generate cases -> Scripts -> generate script -> Runner -> run -> Healer -> validate fix
```

## Troubleshooting

- If dashboard loads but API pages fail, check `NEXT_PUBLIC_API_URL`.
- If sidebar navigation works locally but not deployed, hard refresh after deployment.
- If pages show stale UI, clear browser cache or open incognito.

## Known Limitations

- Dashboard is a navigation and overview page, not an analytics dashboard yet.
- Future versions can add counts, recent runs, recent documents, and health checks.

## Interview Perspective Q&A

**Q: Why have a dashboard if each feature has its own page?**  
A: It reduces onboarding friction and presents the QA workflow as one connected product.

**Q: Why use a shared app shell?**  
A: It keeps navigation consistent and avoids duplicate layout code across pages.

**Q: What would you add next?**  
A: Live system health, recent failed runs, ingestion status, and model configuration status.

**Q: How does the dashboard support product usability?**  
A: It turns many technical workflows into a discoverable sequence for QA users.

