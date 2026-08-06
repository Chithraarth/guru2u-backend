# Guru 2 u — Backend (Express.js API server)

Standalone Express + TypeScript API server (readings, Firebase auth, Stripe billing, entitlements).

## Setup
1. Node.js 20+ and PostgreSQL required.
2. Copy `.env.example` to `.env` and fill in values.
3. `npm install`
4. Push the database schema: `cd vendor/db && npm run push`
5. Dev: `npm run dev` — Prod build: `npm run build && npm start`

Shared code (database schema, validation, AI helpers) is vendored in `vendor/` and linked via file: dependencies.

## Stripe setup
Billing reads plans/prices/subscription status live from the Stripe API (no local mirror table) — nothing to sync or migrate.
1. In the Stripe Dashboard, create a Product per plan (monthly / yearly_basic / yearly_unlimited / extra_reading) with a recurring or one-off Price, and set a `planKey` metadata entry on each Product matching the keys in `src/lib/entitlements.ts`'s `PLAN_LIMITS`.
2. Create a webhook endpoint pointing at `${PUBLIC_BASE_URL}/api/stripe/webhook`, subscribed to whichever events you want logged, and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` (the public origin this API is reachable at) in `.env`.

Auth is verified via the Firebase Admin SDK (`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`).
