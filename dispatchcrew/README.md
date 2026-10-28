# AlphaQ

Orders, stock, and people. In sync.

Live site: https://alphaq-olive.vercel.app

## Run locally

Use Node.js 24 and a PostgreSQL database (Neon works).

```powershell
npm install
Copy-Item .env.example .env
# Set DATABASE_URL. For live AI, set OPENROUTER_API_KEY.
npm run migrate
npm run dev
```

Open http://127.0.0.1:5173. The Vite frontend proxies API requests to port 3001. Production runs on Vercel with Neon PostgreSQL. SQLite files from earlier versions are not used or deleted.

## Demo accounts

Open Log in and choose **Try as customer, staff, manager or owner** for a separate sample workspace. Use the role switcher to follow the same order through each role. For password sign-in, choose **Fill example credentials**.

| Role | Email |
|---|---|
| Customer | customer@demo.alphaq.example |
| Staff | staff@demo.alphaq.example |
| Manager | manager@demo.alphaq.example |
| Owner | owner@demo.alphaq.example |

Password for these public demo accounts: **AlphaQ demo access 2026!**

Credentials apply only to isolated demo workspaces. They never authenticate to the real wholesaler. Demo orders use a labelled scripted interpreter and persist for 24 hours. Live AI uses free OpenRouter models, with paid fallback blocked.

## Product

- Order Mirror, targeted clarification and customer confirmation.
- Stock checks, whole-order holds and approved shortage choices.
- Manager approval with stock impact and simulated customer message.
- Atomic reservations, simulated dispatch, retries and execution history.
- Account roles, customer privacy, CSRF-protected sessions and owner-managed invitations.
- Simulated subscriptions with order and staff-seat limits.
- Dashboard charts, customer directory, activity, reports and CSV export.
- Guided tour and an explanation of the AI workflow.

Dispatch, customer messaging and billing are simulations. No courier, payment or email integration is enabled.

## Checks and deployment

`npm test` runs PostgreSQL integration tests using PGlite. `npm run build` checks TypeScript and builds the UI. `npm run migrate` applies the checked-in schema and catalogue to the configured PostgreSQL database. Vercel environment values must include DATABASE_URL, OPENROUTER_API_KEY and OPENROUTER_MODEL=openrouter/free.

The server uses pooled PostgreSQL connections, per-workspace transaction locks, nested savepoints and unique execution receipts. Demo workspaces use separate PostgreSQL schemas and HttpOnly session cookies. Expired demo namespaces are cleaned up as new demos are allocated. The demo allocation and AI endpoints are rate-limited.

Initial real-owner setup is available only from local development; the production endpoint rejects initial setup. Run locally against the intended database to configure the owner before using real accounts online. Staff accounts are invited by the owner, and customer signup creates a new customer record.

See [DEMO.md](DEMO.md) for the walkthrough and [GOOGLE-SIGN-IN.md](GOOGLE-SIGN-IN.md) for optional Google console setup. Google OAuth is not enabled in this release.
