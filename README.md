# Guru 2 u — Backend (Express.js API server)

Standalone Express + TypeScript API server (readings, Firebase auth).

## Setup
1. Node.js 20+ and PostgreSQL required.
2. Copy `.env.example` to `.env` and fill in values.
3. `npm install`
4. Push the database schema: `cd vendor/db && npm run push`
5. Dev: `npm run dev` — Prod build: `npm run build && npm start`

Shared code (database schema, validation, AI helpers) is vendored in `vendor/` and linked via file: dependencies.

Auth is verified via the Firebase Admin SDK (`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`).
