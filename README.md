# DispatchCrew

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
