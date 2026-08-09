# Target Report Server

Central server + React dashboard for **The Target Project**. It receives activity
batches from Target instances (the report-to-server client built into the target
hub) and visualises workflows, steps, token usage and errors.

Wire contract it implements: `docs/report-server.es.html` §7 in the target repo.

## Requirements

- Node.js **≥ 24** (uses `node:sqlite`, no external dependencies — nothing to
  `npm install`).

## Run

```bash
npm start                 # or: node server.mjs
```

Then open the dashboard at **http://127.0.0.1:8900/**.

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

`public/` is a React 18 SPA with **no CDN and no build step**: React/ReactDOM are
vendored in `public/vendor/`, and `public/app.js` uses `React.createElement`
directly, so nothing is transpiled in the browser and it works fully offline. It
polls the JSON API every few seconds and shows KPIs, the instance fleet,
event/version breakdowns and a live event feed.
