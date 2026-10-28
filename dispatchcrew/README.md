# DispatchCrew

Order operations for a small office-supply wholesaler. Turn an informal order into a catalogue-backed summary, collect missing details, confirm with the customer, and approve a stock-checked simulated warehouse dispatch.

## Run locally

Requires Node.js 24 or newer.

```powershell
cd dispatchcrew
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Configure OPENROUTER_API_KEY in the ignored .env file.
npm run dev
```

Management: http://127.0.0.1:5173/ · Customer intake: http://127.0.0.1:5173/order

The API listens on loopback port 3001. The frontend proxies `/api` to it. `npm run build` checks TypeScript and creates the production frontend; `npm start` serves that build and the API from port 3001. Keep the development API port at 3001 unless you also change the Vite proxy.

## What works

- **Order Mirror:** catalogue IDs, whole-unit quantities and server-calculated INR totals.
- **Ask Once:** targeted product/quantity questions with answers persisted on the order.
- **Customer tracking:** unguessable links, a filtered timeline, confirmation, stock-wait choice and revision.
- **Approval impact:** exact message, quantities, totals and stock before/after, invalidated when stock changes.
- **Exception inbox:** missing details, shortages and failures with an actionable next step.
- **Shortage Choices:** reduce to available units, choose a catalogue-approved alternative, or explicitly remove a short line. Each option shows quantities, price changes and whether units are dropped. A fresh customer confirmation and warehouse approval are always required.
- **Safe execution:** transactional stock reservation, dispatch and simulated message; bounded retries and persisted resume.

SQLite stores prices in integer paise. Stock availability is `on_hand - reserved`; simulated dispatch reserves units and does not decrement on-hand counts. There are no taxes, shipping charges or partial dispatches. Substitutions require a catalogue allowlist and explicit customer choice. Reductions and removals revise the whole order; dropped units are not backordered. Product ambiguity is resolved explicitly, never silently.

### Shortage Choices API

`GET /api/track/:token/shortage-choices` returns a versioned offer with a `quoteId`, short product groups and their available options. The tracking response also includes this offer while the order is on hold. Seeded approved alternatives are A5/A4 notebooks and black/white desk organisers, in both directions; differences in size or colour are disclosed.

`POST /api/track/:token/shortage-choices` accepts `{ version, quoteId, selections: [{ originalProductId, optionId }] }`. Choose exactly one offered option per short product. Prices and quantities are derived server-side from the offer. The server rechecks order version, prices, substitution policy and relevant stock inside a transaction. Stale offers return HTTP 409 without modifying the order. Combined alternatives cannot consume the same stock twice, and the final order cannot be empty.

Accepted choices produce a fresh Order Mirror in `awaiting_confirmation`; they never reserve stock or dispatch directly. Matching retries are idempotent. Management order details include persisted `revisions` with before/after lines, totals and versions. Constructing and applying choices makes no AI calls.

Two real model calls normally handle interpretation/planning and fulfilment drafting. Deterministic workers enforce inventory, prices, confirmations and approvals. The supported workflow is bounded: AI cannot introduce arbitrary tools or skip server checkpoints. There is no fallback AI parser when a key is missing or an API request fails.

The default is OpenRouter's zero-cost `openrouter/free` route. Only this route or an explicitly listed `:free` model can be used; paid model IDs are rejected locally, and provider prompt/completion price caps are zero. There is no paid fallback and the existing OpenAI key is never used. Free-model availability, latency and rate limits vary. Only catalogue fields needed for extraction are sent to intake. Approval, inventory, tracking, duplicate detection and dispatch retries run in code without model calls.

## Examples and demonstration

On first run, the database contains eight products, five synthetic customers and six **labelled seeded examples**. These examples use explicit fixture data during seeding, not live model output. Newly created orders always use the configured real AI provider. Continuing a seeded example through an AI step also uses the real provider.

1. Open the customer view. Choose **Office essentials**, review the Order Mirror, then confirm. In management select that order, inspect stock/message, and choose **Approve & dispatch**. Return to the tracking page to see the receipt.
2. Choose **Needs a detail**. Select A5 or A4 notebooks, submit the answer, and confirm the revised mirror. For a shortage, order **12 desktop staplers**; the customer can wait or revise. Management can add demo stock in Inventory and choose **Recheck stock**.
3. On an order awaiting approval, expand **Test safe recovery** and arm the failure test. Approve it. All three attempts roll back; choose **Retry saved step** and inspect the final receipt and execution trail. Exactly one reservation set, dispatch and message are recorded.

Customer messages and dispatch records are simulated. No real email, payment, courier booking or shipment happens.

## Commands

```powershell
npm test          # isolated workflow and HTTP integrity tests
npm run build     # TypeScript and production build
npm run test:live # real-model end-to-end flow in an isolated in-memory database
npm run seed      # seed only an empty database
npm run reset     # delete local demo business data and seed fresh examples; stop the server first
```

`DATABASE_PATH` defaults to `./data/dispatchcrew.sqlite`. `OPENROUTER_MODEL` defaults to `openrouter/free`. `DEMO_CONTROLS=false` disables stock adjustments and failure injection. The ignored `.env` and database must not be committed. Obtain an OpenRouter key at https://openrouter.ai/settings/keys and save it only to the ignored local `.env` file. No OpenAI credits are needed.

## Deployment boundary

This is a local, single-operator demonstration with synthetic data, not a public multi-tenant service. Management routes deliberately have no authentication. Tracking tokens grant access to one order's customer view; treat links as private. Public deployment requires authentication, tenant isolation, rate limits and a defined retention policy. Live messaging and shipping adapters are future integrations.

## Account and subscription foundations

This branch includes service foundations for a single wholesaler, with Owner, Manager, Staff and Customer roles. The wholesaler pays for DispatchCrew; customers order without a platform subscription. New customers can register a new customer identity, while access to existing customer records requires an owner-issued invitation.

Implemented service-level pieces include salted scrypt password hashing, hashed opaque sessions, CSRF validation, invitation binding, account disabling with session revocation, simulated plan activation, staff-seat checks and monthly order quotas. Provisional simulation tiers are Free (25 orders/month, 2 staff seats), Starter (250 orders/month, 5 seats, INR 999/month) and Pro (1,000 orders/month, 15 seats, INR 2,499/month). Owner accounts count as staff seats; customer accounts do not.

These services are **not connected to the application routes or account screens yet**. Current management endpoints remain unauthenticated, and subscription limits are not yet enforced on those endpoints. The branch must not be deployed as a secured or billable product. Eight service tests cover these foundations in addition to the 33 existing workflow and HTTP tests. No real payments are collected.
