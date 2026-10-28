# AlphaQ

[Live app](https://alphaq-olive.vercel.app) · [Guided tour](https://alphaq-olive.vercel.app/demo?tour=1) · [Demo login](https://alphaq-olive.vercel.app/login)

For judging, choose **Try as customer, staff, manager or owner** on the login page. Switch roles in the demo banner to follow the same order. No API key or payment is needed to explore the role demos.

| Demo role | Email |
|---|---|
| Customer | customer@demo.alphaq.example |
| Staff | staff@demo.alphaq.example |
| Manager | manager@demo.alphaq.example |
| Owner | owner@demo.alphaq.example |

Public demo password: **AlphaQ demo access 2026!** Use **Fill example credentials** on the login page. These credentials apply only to a separate sample workspace.

Demo interpretation is scripted and labelled. The real integration uses free OpenRouter models, which can be unavailable or rate-limited. Paid fallback is blocked. Dispatch, messaging and billing are simulated.

AI-assisted order operations for small wholesalers. Turn a customer's written request into a verified order, resolve shortages, collect approval, and prepare a simulated warehouse dispatch.

The application lives in [`dispatchcrew/`](dispatchcrew/). See its [setup and workflow guide](dispatchcrew/README.md) for configuration, architecture, and demonstration scenarios.

## Features

- Catalogue-backed Order Mirror with server-calculated INR totals.
- Targeted clarification and customer confirmation.
- Inventory checks, shortage holds, and customer-selected reductions or approved alternatives.
- Manager approval with stock-impact and message previews.
- Transactional reservations and simulated dispatch with safe retries and duplicate prevention.
- Customer tracking, order revisions, and persisted execution history.
- Free-only OpenRouter integration with paid models blocked.

## Run locally

Requires Node.js 24 or newer.

```powershell
cd dispatchcrew
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Set OPENROUTER_API_KEY in .env.
npm run dev
```

Management: `http://127.0.0.1:5173/` · Customer intake: `http://127.0.0.1:5173/order`

```powershell
npm test
npm run build
```

This version is a local demonstration using synthetic business data. Dispatch and messaging are simulated; no real shipment or payment is made. Management authentication and subscription billing are under development. Do not expose the current management API publicly.
