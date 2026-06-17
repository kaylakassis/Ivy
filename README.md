# Ivy OS

All-in-one business platform for solo owners and small teams. Vite + React frontend, Vercel serverless backend, Vercel Postgres for persistence.

## Stack

- **Frontend:** Vite + React 18 + React Router 6
- **Styling:** CSS custom properties (two visual directions — Calm / Bold), Inter + Fraunces + Space Grotesk
- **Backend:** Vercel serverless functions (`/api/**/*.js`)
- **Database:** Neon serverless Postgres (`@neondatabase/serverless`)
- **Deployment:** Vercel (framework preset: Vite)

## Project layout

```
.
├── index.html                    # Vite entry
├── package.json
├── vite.config.js
├── vercel.json                   # Vercel framework config + SPA rewrites
├── .env.example
├── api/                          # Vercel serverless functions → deployed at /api/*
│   ├── health.js                 # GET /api/health
│   └── _lib/
│       ├── db.js                 # Vercel Postgres client
│       └── json.js               # response helpers
├── src/
│   ├── main.jsx                  # React entry — mounts <App />
│   ├── App.jsx                   # Route definitions
│   ├── styles/
│   │   ├── tokens.css            # design tokens (dir-calm / dir-bold)
│   │   └── global.css            # base styles, primitives (.btn, .card, .chip, .nav-item)
│   ├── components/
│   │   ├── Icons.jsx             # stroke-based icon set
│   │   ├── EmptyNote.jsx
│   │   └── layout/
│   │       ├── AppShell.jsx      # <Sidebar /> + <Topbar /> + <Outlet />
│   │       ├── Sidebar.jsx
│   │       └── Topbar.jsx
│   ├── lib/
│   │   ├── api.js                # fetch wrapper against /api
│   │   ├── nav.js                # nav items + page titles
│   │   └── tweaks.js             # visual direction (localStorage-backed)
│   └── features/                 # one folder per top-level feature
│       ├── dashboard/
│       ├── clients/
│       ├── calendar/             # + PublicBooking.jsx (route /book/:slug)
│       ├── finance/
│       ├── goals/
│       ├── rewards/
│       ├── messages/
│       ├── documents/
│       ├── website/              # + PublicSite.jsx (route /site/:handle)
│       └── ivy/
├── project/                      # original HTML/Babel prototype (reference only)
│   ├── Ivy OS.html
│   └── src/                      # feature source used by the prototype
└── chats/                        # design chat transcripts
```

## Getting started

```bash
npm install
cp .env.example .env            # then fill in JWT_SECRET + ADMIN_SECRET
npm run dev
```

App runs on http://localhost:5173. For the API routes, you'll need `vercel dev` (or deploy
to Vercel) — plain `vite dev` serves only the frontend.

## Deploying to Vercel

1. Push this repo to GitHub.
2. In Vercel → Add New Project → import the GitHub repo. Framework preset: **Vite**.
3. In the project's **Storage** tab, add a **Neon** database (this is the native
   Vercel Postgres replacement). Vercel will auto-inject `DATABASE_URL`.
4. Add the rest of the env vars from `.env.example` (`JWT_SECRET`, `ADMIN_SECRET`).
5. Deploy. `/api/**` files are deployed as serverless functions automatically.
6. **Run the one-time migration** to create tables:
   ```bash
   curl -X POST https://<your-app>.vercel.app/api/admin/migrate \
     -H "x-admin-secret: $ADMIN_SECRET"
   ```
   → responds with `{ "applied": N }` once tables are created.

## Auth + data model

- `users`      — email + bcrypt password hash + name
- `workspaces` — 1 per user (ownership)
- `websites`   — 1 per workspace; `{ handle, business_name, template, sections (jsonb), launched, published_at }`

Session is a JWT in an httpOnly cookie (`ivy_session`, 30-day expiry). Routes under
`/api/auth/*` handle signup/login/logout/me. All other `/api/*` routes call `requireUser()`
to authenticate, except `/api/website/public/:handle` which serves published sites.

## Security

See [SECURITY.md](./SECURITY.md) for the threat model, tenancy guarantees,
CSRF/CORS posture, rate limits, and the operator checklist before onboarding
real users. Short version: every authenticated endpoint is workspace-scoped,
session is an httpOnly + secure + sameSite-lax JWT cookie, every state-changing
endpoint additionally enforces same-origin via Origin/Referer check, no
analytics or tracking is loaded, all queries are parameter-bound. Run the
migrate endpoint once after first deploy to create tables.

## Current status

- ✅ Project scaffold (routing, shell, design tokens, icons, API skeleton)
- ✅ Auth (Postgres users + workspaces, JWT cookie, signup / signin / signout,
      password reset, email verification, rate limiting)
- ✅ Website builder: editor UI + API persistence + public read route
- ✅ Clients (CRM): full CRUD, analytics, drawer with inline edit
- ✅ Calendar: D/W/M views, services with photos + reminders + prep
      instructions, recurring appointments, public booking page
- ✅ Messages: text chat between owner and clients with two-way / broadcast modes
- ✅ Security hardening: CSRF, headers, error sanitisation, SECURITY.md
- ⏳ Port remaining features (Documents, Finance, Goals, Rewards, Ivy)
- ⏳ Messages attachments (images / files via Vercel Blob)
- ⏳ Reminders delivery (cron + email after Documents/Messages glue lands)

## Reference: the prototype

`project/Ivy OS.html` is the original design prototype (React + Babel in-browser). Every feature was designed and iterated there — treat it as the source of truth for visuals and UX. The feature stubs in `src/features/*` will be fleshed out to match, then wired to the Postgres-backed API.
