# Target Report Server

Central server + React dashboard for **The Target Project**. It receives activity
batches from Target instances (the report-to-server client built into the target
hub) and visualises workflows, steps, token usage and errors.

Wire contract it implements: `docs/report-server.es.html` §7 in the target repo.

## Requirements

- Node.js **≥ 24**. The server uses **two runtime dependencies** (`joi` for request
  validation, `nodemailer` for invitation/recovery mail); everything else is
  builtins (`node:sqlite`, `node:crypto`, …). The dashboard has its own build
  step (React + Vite, in `ui/`).

## Run

```bash
npm ci                    # joi + nodemailer
npm run ui:install        # installs the dashboard's dependencies, then builds it
npm start                 # or: node server.mjs
```

Sign in at **http://127.0.0.1:8900/** with the seeded admin account
(`admin@admin.com` / `password-target-server` on a fresh database). Change that
password before deploying — the server refuses to start on a public bind while
the published default is still in place.

`npm run build` (ui/src → public/dist) on its own is enough after a UI change;
`ui:install` runs it for you. `public/dist` is gitignored, so a `git pull` that
touches `ui/` leaves the built bundle behind — the server notices and refuses to
serve a stale dashboard, telling you to rebuild rather than showing you an old
one. Set `TARGET_SKIP_UI_STALE_CHECK=1` to serve it anyway.

Then open the dashboard at **http://127.0.0.1:8900/**.

The API (`/ingest`, `/api/*`, `/health`) works without building the UI — the
server only needs `public/dist` to serve the dashboard, and says so in the
browser if it is missing or out of date.

While working on the dashboard, `npm run ui:dev` serves it on
**http://127.0.0.1:5174/** with hot reload, proxying `/api`, `/health` and
`/ingest` to the running server on 8900 (override with `VITE_SERVER_ORIGIN`).

Configuration (env vars):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8900` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `TARGET_INGEST_TOKEN` | _(empty)_ | If set, `POST /ingest` requires `Authorization: Bearer <token>` |
| `TARGET_SERVER_DB` | `./target-server.db` | SQLite file |
| `TARGET_SKIP_UI_STALE_CHECK` | _(empty)_ | If set, serve `public/dist` even when it is older than `ui/` |
| `TARGET_AUTH_SECRET` | _(generated + stored in DB)_ | HS256 signing key for sessions |
| `TARGET_AUTH_TTL_HOURS` | `8` | Access-token lifetime |
| `TARGET_AUTH_SECURE_COOKIE` | auto | Add `Secure` to the session cookie (on when `TARGET_PUBLIC_URL` is `https://`) |
| `TARGET_PUBLIC_URL` | `http://HOST:PORT` | Origin for emailed setup/reset links (**required** on a public bind) |
| `TARGET_SMTP_URL` | _(empty)_ | `smtp(s)://user:pass@host:port` — **required** on a public bind (unless `TARGET_ALLOW_FILE_MAIL=1`) |
| `TARGET_MAIL_FROM` | `target-server@localhost` | Envelope / From address |
| `TARGET_MAIL_TRANSPORT` | auto | Force `smtp` \| `file` \| `noop` (file is the local default) |
| `TARGET_ALLOW_FILE_MAIL` | `0` | Allow file/noop mail transport on a public bind |
| `TARGET_SEED_ADMIN_PASSWORD` | published default | Password for the seeded `admin@admin.com` — set before first boot when deployed |
| `TARGET_TRUST_PROXY` | `0` | Use the last hop of `X-Forwarded-For` for rate limiting (only behind a trusted proxy) |
| `TARGET_AUTH_DISABLED` | `0` | Skip the API auth guard (local dev/tests only; refused on a public bind) |

## Authentication

JWT sessions in an `httpOnly` cookie (Bearer header also accepted). Every
`/api/*` route except `/api/auth/*` requires a signed-in operator.
`POST /ingest` keeps its own `TARGET_INGEST_TOKEN` and is unchanged.

Human accounts live under `/api/auth/users` — distinct from `GET /api/users`,
which still lists reporting instance display names.

First run on a fresh database seeds `admin@admin.com`. Invite additional
operators from the **Users** panel: the server emails a single-use setup link
(no password in mail). Local/CI defaults write `.mail-outbox/*.eml` instead of
using SMTP.

### Deployment

On any non-loopback `HOST`, the server **refuses to start** without:

- `TARGET_PUBLIC_URL` (links must not come from the bind address or Host header)
- a real mail transport (`TARGET_SMTP_URL`, unless `TARGET_ALLOW_FILE_MAIL=1`)
- a non-default seed admin password (`TARGET_SEED_ADMIN_PASSWORD`)

It also refuses `TARGET_AUTH_DISABLED=1` on a public bind. Set
`TARGET_INGEST_TOKEN` before exposing the port.

#### Render

The repo includes [`render.yaml`](render.yaml) (Blueprint). To deploy:

1. Push this repo to GitHub (branch `main`).
2. In the [Render Dashboard](https://dashboard.render.com) → **Blueprints** → **New Blueprint Instance**, select `EnmaSuamkf/target-server`.
3. When prompted, set the secret env vars (`sync: false` in the Blueprint):
   - `TARGET_SMTP_URL` — e.g. `smtps://resend:re_KEY@smtp.resend.com:465` (Resend API key is read from this URL on Render; SMTP ports are blocked on the free plan, so the server uses Resend's HTTPS API instead)
   - `TARGET_SEED_ADMIN_PASSWORD` — non-default password for `admin@admin.com` (before first boot)
   - `TARGET_AUTH_SECRET` — optional; generated on first boot if omitted
   - `TARGET_INGEST_TOKEN` — optional; protects `POST /ingest`
4. Deploy. The service URL is **https://target-server.onrender.com** (matches `TARGET_PUBLIC_URL` in the Blueprint).

Build: `npm ci && npm --prefix ui ci && npm run build`. Start: `node server.mjs`.
Health check: `GET /health`. SQLite lives at `TARGET_SERVER_DB` (ephemeral on the free plan unless you add a persistent disk).

## Point a Target instance at it

In the target repo's `.env`:

```
TARGET_REPORT_URL=http://127.0.0.1:8900/ingest
TARGET_REPORT_TOKEN=whatever          # must match TARGET_INGEST_TOKEN if you set one
TARGET_REPORT_ENABLED=true
```

Start the hub and use it — batches appear on the dashboard within a few seconds.

## API

All `GET /api/*` routes below require a session unless noted.

- `POST /api/auth/login` — sign in (`admin@admin.com` on a fresh DB)
- `POST /api/auth/logout` — sign out
- `GET /api/auth/me` — current operator
- `POST /api/auth/forgot-password` — email a reset link (always 202)
- `POST /api/auth/setup` — complete an invitation (`/setup?token=…`)
- `POST /api/auth/reset-password` — set password from recovery link
- `GET/POST/DELETE /api/auth/users` — list, invite, delete human accounts
- `POST /api/auth/users/:id/invite` — resend invitation

- `POST /ingest` — receive a batch (optional ingest token; not session auth). Returns `{ accepted: [id...], rejected: [{id,reason,detail}] }`.
  Idempotent: re-sending the same event ids inserts nothing new but still acks them.
- `GET /api/stats?from=&to=&user=&instance=&workflow=&kind=&agent=&sandbox=` — totals,
  events-by-kind, versions, usage sums, plus `agents`/`sandboxes` (the distinct values ever
  reported, unfiltered, for the filter dropdowns). All filters optional; `from`/`to` are ISO
  bounds on `received_at`, `user` is the instance's display name.
- `GET /api/instances` — the reporting fleet.
- `GET /api/users` — distinct reporting users (instance display names) with event counts.
- `GET /api/events?limit=&kind=&instance=&workflow=&user=&agent=&sandbox=&from=&to=` — recent events.
  `agent` (runner: `claude`, `free-code`, …) and `sandbox` (`host`|`docker`) match the workflows
  that reported those values in `workflow.created`/`workflow.updated`; instance-level events
  (heartbeats) belong to no workflow and drop out while either filter is on.
- `GET /api/workflows?limit=&offset=&user=&instance=&agent=&sandbox=&from=&to=` — one aggregate row per workflow: name
  (latest `workflow.created`/`workflow.updated`, falling back to the 8-char id prefix), `agent`,
  `sandbox` and `image` (latest event carrying each), user, derived `status`
  (newest signal wins: an unsettled `step.started` newer than the last `workflow.status_changed`
  reads `running`; a pending `step.added` newer than a terminal status reads `draft`, mirroring
  the hub reopening the workflow), step counts (`stepsAdded`/`stepsStarted`/`stepsDone`/`stepsFailed`)
  plus `stepsTotal` (plan size: the max of the counts and the largest `order_index` + 1, so steps
  created before `step.added` existed — or whose lifecycle events were lost to a restart — still
  count), token sums and first/last activity. The step list itself is reconstructed from
  `step.added` events (the plan) plus the `step.started`/`step.done`/`step.failed`/`step.judged`
  lifecycle events.

  **The list is always paged** — a fleet reporting thousands of workflows must not be able to
  render as one endless page. The response is `{ workflows, total, limit, offset }`, where `total`
  is the unpaged match count the pager reads its "of N" from. `limit` defaults to 25 and is
  clamped to 1–200, so omitting it (or asking for 10000) still returns one page. Rows are ordered
  newest activity first, tie-broken by `workflowId`, which makes the order total: paging straight
  through visits every workflow exactly once even when a whole ingest flush shares a timestamp.
- `GET /api/workflows/names?user=&instance=&agent=&sandbox=&from=&to=` — every matching workflow as
  `{ workflowId, name }` only (capped at 1000). This is what the filter bar's workflow dropdown
  reads, so paging the list above can never hide a workflow from it; it skips the per-row fold and
  stays cheap.
- `GET /api/workflows/:id` — the workflow summary above plus `steps[]` (per-step status,
  duration, retries, sorted by `orderIndex`) and its 50 most recent events.
  404 when the id never reported.
- `GET /health` — liveness.

The dashboard exposes the same filters (date range incl. a custom from/to, user, instance,
workflow, event kind) in its filter bar; every panel answers the filtered query. A
"Workflows" panel lists the aggregate rows above and expands into a per-workflow step
canvas (status dots down a vertical rail) with that workflow's recent events.

## Storage

`node:sqlite` with two tables: `instances` (identity + version + last seen) and
`events` (one row per activity event; `id` is the PRIMARY KEY, which is what makes
ingest idempotent). See `db.mjs`.

## Test

```bash
npm test
```

Boots the server on an ephemeral port and exercises ingest, idempotency,
validation and the dashboard API.

## Dashboard

`ui/` is a **React 19 + TypeScript + Vite** single-page app, laid out like the
target repo's `hub/ui`:

```
ui/
  index.html  vite.config.ts  tsconfig.json  package.json
  src/
    main.tsx  App.tsx              # shell: top bar, KPIs, panels
    api/types.ts                   # the shapes server.mjs returns
    api/kinds.ts                   # event kind → label + tooltip + badge tone
    hooks/useApi.ts                # GET + poll, keeps data across refreshes
    lib/format.ts                  # timeAgo / compactTokens / durations
    lib/eventSummary.ts            # event payload → headline + facts (prose, not JSON)
    components/                    # FilterBar, WorkflowsTable, StepCanvas,
                                   # WorkflowDetail, EventFeed, EventPayload,
                                   # Badges, Bars…
    styles/global.css
```

`npm run build` type-checks (`tsc --noEmit`, strict) and emits the bundle to
`public/dist/`, which `server.mjs` serves as static files. The build output is
gitignored — clone, `npm run ui:install && npm run build`, and you have it.

The app polls the JSON API every 4s and shows KPIs, the workflow table (with a
per-workflow step canvas), the instance fleet, event/version breakdowns and a
live event feed.

Event payloads are rendered as prose, not JSON: each event gets a headline
sentence ("Step 2 finished in 17s", "in 18.6k · out 83 · 1.9% of 1.0M context"),
the free text it carries (a step description, an acceptance criterion, an error
message), its remaining fields as labelled facts, and — for `workflow.plan` —
its steps as a list you can open. The raw JSON stays one click away under "Raw
payload", so nothing the summary leaves out is lost. `lib/eventSummary.ts` owns
that mapping; kinds it has never seen still get every scalar labelled.
