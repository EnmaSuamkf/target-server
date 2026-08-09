# Target Report Server

Central server + React dashboard for **The Target Project**. It receives activity
batches from Target instances (the report-to-server client built into the target
hub) and visualises workflows, steps, token usage and errors.

Wire contract it implements: `docs/report-server.es.html` §7 in the target repo.

## Requirements

- Node.js **≥ 24**. The server itself has **no dependencies** (`node:sqlite` and
  other builtins); only the dashboard has a build step (React + Vite, in `ui/`).

## Run

```bash
npm run ui:install        # once: installs the dashboard's dependencies
npm run build             # once per UI change: ui/src → public/dist
npm start                 # or: node server.mjs
```

Then open the dashboard at **http://127.0.0.1:8900/**.

The API (`/ingest`, `/api/*`, `/health`) works without building the UI — the
server only needs `public/dist` to serve the dashboard, and says so in the
browser if it is missing.

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

## Point a Target instance at it

In the target repo's `.env`:

```
TARGET_REPORT_URL=http://127.0.0.1:8900/ingest
TARGET_REPORT_TOKEN=whatever          # must match TARGET_INGEST_TOKEN if you set one
TARGET_REPORT_ENABLED=true
```

Start the hub and use it — batches appear on the dashboard within a few seconds.

## API

- `POST /ingest` — receive a batch. Returns `{ accepted: [id...], rejected: [{id,reason,detail}] }`.
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
- `GET /api/workflows?user=&instance=&agent=&sandbox=&from=&to=` — one aggregate row per workflow: name
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
    components/                    # FilterBar, WorkflowsTable, StepCanvas,
                                   # WorkflowDetail, EventFeed, Badges, Bars…
    styles/global.css
```

`npm run build` type-checks (`tsc --noEmit`, strict) and emits the bundle to
`public/dist/`, which `server.mjs` serves as static files. The build output is
gitignored — clone, `npm run ui:install && npm run build`, and you have it.

The app polls the JSON API every 4s and shows KPIs, the workflow table (with a
per-workflow step canvas), the instance fleet, event/version breakdowns and a
live event feed.
