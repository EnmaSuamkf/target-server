# Token pricing and cost reporting

The dashboard shows what each workflow cost, in USD. Cost is **never stored on
events**: it is computed when the data is read, from the `usage.snapshot` events
a hub reports and the per-organization price table kept in the `pricing_rules`
table. Editing a rule therefore reprices history, and `effectiveFrom` (below)
keeps old runs on the tariff that applied at the time.

Code: `pricing.mjs` (pure maths, no storage), `db.mjs` (rules storage and
cost-at-read), `server.mjs` (`handlePricingRoute`). Tests: `test/pricing-core.test.mjs`,
`test/pricing-db.test.mjs`, `test/pricing-api.test.mjs`, `test/pricing-ui.test.mjs`.

## How cost is computed

### Last snapshot per session

A `usage.snapshot` carries the **running total** of its session, not the step's
own spend (the hub re-reads the transcript each time). The correct figure is the
**last** snapshot of each `(workflow_id, session_id)`, summed across the
workflow's sessions. Cost follows the same rule as the token totals: snapshots
of one session are never added together.

### Four token buckets

Each session total is split into four buckets, priced at their own rate:

| Bucket | Snapshot field | Rate |
| --- | --- | --- |
| Uncached input | `input_tokens_uncached` | `inputPerMtok` |
| Cache creation | `cache_creation` | `cacheWritePerMtok` (blank → `inputPerMtok`) |
| Cache read | `cache_read` | `cacheReadPerMtok` (blank → `inputPerMtok`) |
| Output | `output_tokens` | `outputPerMtok` |

```
cost = (uncached × input + cache_creation × cacheWrite + cache_read × cacheRead + output × output) / 1,000,000
```

This matters: with prompt caching on, most "input" is cache reads. In one real
session 57M of 59M input tokens were cache reads, so pricing all input at the
plain input rate would overstate the cost roughly tenfold. Old-shape payloads
are normalised first (`normalizeUsageSnapshot` in `db.mjs`).

Worked example, rule `claude` / `claude-opus-*` at input $15, output $75, cache
read $1.50, cache write $18.75, and a session with 2M uncached input, 57M cache
read, 0 cache creation and 300k output tokens:

```
2 × 15 + 57 × 1.5 + 0.3 × 75 = 30 + 85.5 + 22.5 = $138.00
```

(All input at the input rate would give 59 × 15 + 22.5 = $907.50.)

## Pricing rules

Prices are **USD per million tokens**. USD is the only currency.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | integer | Assigned by the server. |
| `agent` | string, default `*` | The **runner** (`claude`, `free-code`, `cursor`, `copilot`), not the LLM. `*` = any. |
| `model` | string, default `*` | Model name. `*` = any; a **trailing** `*` is a prefix glob (`claude-opus-*`). |
| `inputPerMtok` | number 0..1,000,000, required | Uncached input rate. |
| `outputPerMtok` | number 0..1,000,000, required | Output rate. |
| `cacheReadPerMtok` | number or `null` | Cache-read rate; `null` falls back to `inputPerMtok`. |
| `cacheWritePerMtok` | number or `null` | Cache-creation rate; `null` falls back to `inputPerMtok`. |
| `effectiveFrom` | ISO date/time or `""` | `""` = always; otherwise the instant the rule starts applying. |
| `createdAt`, `updatedAt` | ISO time | Server-managed. |

`(agent, model, effectiveFrom)` is unique; a second rule with the same triple is
a `409 duplicate_rule`. Dates are normalised to a full ISO instant
(`2026-01-01` is stored as `2026-01-01T00:00:00.000Z`).

### Matching and precedence

For a session's `(agent, model)` at the time of its last snapshot, the server
picks one rule:

1. **Model specificity first**: exact name > longest prefix glob > `*`.
2. Then **agent**: exact > `*`.
3. Then the **newest `effectiveFrom`** among the rules that are already in force.

A rule is eligible only if `effectiveFrom <= snapshot time`. A session whose
model is `null` can match only rules whose model is `*`.

Worked example with these rules:

| Rule | agent | model |
| --- | --- | --- |
| A | `*` | `*` |
| B | `claude` | `*` |
| C | `*` | `claude-opus-*` |
| D | `claude` | `claude-opus-4` |

| Session (agent / model) | Rule used | Why |
| --- | --- | --- |
| `claude` / `claude-opus-4` | D | exact model |
| `claude` / `claude-opus-5` | C | glob beats `*`; model outranks agent, so C wins over B |
| `claude` / `claude-sonnet-5` | B | no model match beyond `*`; exact agent beats `*` |
| `claude` / `null` | B | null model matches only model `*` |
| `cursor` / `gpt-x` | A | falls through to `*` / `*` |

### `effectiveFrom`

To change a price without repricing the past, add a **new** rule with the same
agent and model and a later `effectiveFrom`, and leave the old one in place.
Runs whose last snapshot predates the new date keep the old rate; later runs use
the new one. Editing the existing rule instead reprices everything it covers.

### Hub cost wins; "no tariff" is null, never 0

- If a snapshot carries a numeric `cost_usd`, that value is used as is
  (`costSource: "hub"`) and no rule is consulted.
- Otherwise the matched rule prices the session (`"pricing"`).
- With neither, the session is **unpriced**: `costUsd: null`, `costSource: "unpriced"`.
  A missing tariff is never shown as `$0`, which would read as "free".
- Totals sum only priced sessions. A total is `null` when nothing was priced.
  `unpricedSessions` counts the sessions left out; a workflow row with some but
  not all sessions priced has `costPartial: true` (the figure is a lower bound,
  shown as `>= $x` in the dashboard).

### Which agent is used

The agent is the runner, announced in `workflow.created` / `workflow.updated`
events (`data.agent`). The server uses `data.agent` **inside the snapshot** when
the hub sends it, otherwise the latest agent announced by the workflow's events.

### Known limitation: `model` is null until the hub reports it

Today's hubs send `"model": null` and `"cost_usd": null` in `usage.snapshot`, so
those sessions can only match rules with model `*`. Until the hub is updated,
cover them with **`(agent, *)` rules**, for example one rule `claude` / `*` at
your usual model's prices. Once the hub reports `model` (and `agent`), more
specific rules such as `claude` / `claude-opus-*` take over automatically, with
no migration. The "Unpriced usage" list in Settings shows which `(agent, model)`
pairs still have no rule.

### GitHub Copilot (`copilot`)

Copilot bills per token (1 AI credit = $0.01), so the usual `(agent, model)` rules
fit. `docs/copilot-pricing-rules.json` is a ready-to-import file with agent
`copilot`, one exact-model rule per priced row of the official table
(<https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>,
read 2026-10-02). It ships with `"mode": "merge"`, so importing it keeps your
other rules; it only upserts the `copilot` ones.

- **Import:** Settings → Pricing → Import, or
  `POST /api/settings/pricing/import` with the file as the body (see
  [Export and import](#export-and-import)). Needs `pricing.import`.
- **Model naming:** the id is what Copilot writes to its events (dotted, lower
  case): `Claude Haiku 4.5` → `claude-haiku-4.5`, `GPT-5.4 nano` → `gpt-5.4-nano`.
  Rules are exact, with no globs, so `claude-sonnet-4` does not catch
  `claude-sonnet-4.6`. A model without a rule stays "unpriced" (null), never $0.
  Observed ids (seen in real runs): `claude-haiku-4.5`, `claude-sonnet-4.6`,
  `gpt-5-mini`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `mai-code-1.1-flash`.
  **All the others are inferred** from the display name by the same rule and
  should be confirmed on first use.
- **Cache write:** `null` where the table says "Not applicable" (OpenAI before
  GPT-5.6, Gemini, Grok, Kimi, MAI), so cache creation falls back to the input rate.
- **Tiers:** models with a Long context tier (GPT-5.4, GPT-5.5, GPT-5.6, GPT-6.x,
  Grok 4.x) only get the **Default tier** rule. A session whose input goes
  beyond the threshold (200K or 272K input tokens, per model) is billed at the
  higher Long context rate by GitHub, so it is **under-estimated** here.
- **Skipped:** `Claude Opus 4.8 (fast mode) (preview)` (10.00 / 1.00 / 12.50 /
  50.00) has no known model id, and a guess could mis-price regular Opus 4.8, so
  it has no rule and shows as unpriced. The "Fine-tuned (GitHub)" table is empty.
  Code completions are not billed in AI credits.
- **Gemini 3.6/3.7/3.8 Flash** carry the promotional price (0.75 / 0.075 / 3.75)
  through 2026-12-31; update the rules after that date.
- **Legacy request-based plan:** accounts still on the request-based plan
  (annual Copilot Pro / Pro+) are billed in **premium requests** with model
  multipliers, not per token (their sessions report `totalNanoAiu` 0). On those
  accounts the dashboard figure is an **estimate** of what the tokens would cost,
  not the amount billed.
- The hub reports `cost_usd` as null for Copilot, so the server always prices by
  tokens.

## HTTP API

Base path `/api/settings/pricing`. Requests and responses are JSON. All routes
need a session (`401` otherwise) and the permission listed (`403` otherwise).
Validation failures are `422 {"errors": [{field, code, message}]}`.

| Method and path | Permission | Success |
| --- | --- | --- |
| `GET /api/settings/pricing` | `pricing.read` | `200 {rules, unpriced}` |
| `POST /api/settings/pricing` | `pricing.edit` | `201 {rule}` |
| `PUT /api/settings/pricing/:id` | `pricing.edit` | `200 {rule}` |
| `PATCH /api/settings/pricing/:id` | `pricing.edit` | `200 {rule}` |
| `DELETE /api/settings/pricing/:id` | `pricing.edit` | `200 {ok: true}` |
| `GET /api/settings/pricing/export` | `pricing.export` | `200` attachment `pricing-export.json` |
| `POST /api/settings/pricing/import` | `pricing.import` | `201 {rules}` |

Other statuses: `404 {"error":"not_found"}` for an unknown `:id` on
PUT/PATCH/DELETE, `409 {"error":"duplicate_rule"}` when the
`(agent, model, effectiveFrom)` triple already exists (create, update or
PATCH), `405` for an unsupported method. `PUT` takes a full rule; `PATCH` merges
the fields you send onto the existing rule before validating.

### List

```
GET /api/settings/pricing
200 {"rules": [], "unpriced": []}
```

`unpriced` lists the `(agent, model)` pairs that reported usage but match no
rule, most sessions first, to help fill the table:

```json
{"unpriced": [{"agent": "claude", "model": null, "sessions": 12, "inputTokens": 59000000, "outputTokens": 300000}]}
```

### Create

```
POST /api/settings/pricing
{"agent":"claude","model":"claude-opus-*","inputPerMtok":15,"outputPerMtok":75,"cacheReadPerMtok":1.5,"cacheWritePerMtok":18.75}

201 {"rule":{"id":1,"agent":"claude","model":"claude-opus-*","inputPerMtok":15,"outputPerMtok":75,
     "cacheReadPerMtok":1.5,"cacheWritePerMtok":18.75,"effectiveFrom":"",
     "createdAt":"2026-10-01T14:35:00.143Z","updatedAt":"2026-10-01T14:35:00.143Z"}}
```

Repeating the same body returns `409 {"error":"duplicate_rule"}`. A negative
price returns:

```
422 {"errors":[{"field":"inputPerMtok","code":"number.min","message":"must be greater than or equal to 0"}]}
```

### Update

```
PATCH /api/settings/pricing/1
{"outputPerMtok":80}

200 {"rule":{"id":1, ... "outputPerMtok":80, ...}}
```

### Delete

```
DELETE /api/settings/pricing/1   → 200 {"ok":true}
DELETE /api/settings/pricing/99  → 404 {"error":"not_found"}
```

Past runs the rule priced become unpriced (or fall to a less specific rule).

### Export and import

`GET /api/settings/pricing/export` returns the table without ids or timestamps,
as an attachment (`content-disposition: attachment; filename="pricing-export.json"`):

```json
{
  "kind": "target.pricing",
  "rules": [
    {"agent": "claude", "model": "claude-opus-*", "inputPerMtok": 15, "outputPerMtok": 75,
     "cacheReadPerMtok": 1.5, "cacheWritePerMtok": 18.75, "effectiveFrom": ""},
    {"agent": "*", "model": "*", "inputPerMtok": 3, "outputPerMtok": 15,
     "cacheReadPerMtok": null, "cacheWritePerMtok": null, "effectiveFrom": "2026-01-01T00:00:00.000Z"}
  ]
}
```

`POST /api/settings/pricing/import` takes that file plus an optional `mode`:

```json
{"kind": "target.pricing", "mode": "replace", "rules": [ ... ]}
```

- `kind` is optional; if present it must be `"target.pricing"`.
- `mode` is `"replace"` (default) or `"merge"`.
  `replace` swaps the whole table in a single transaction (a bad row leaves the
  old table untouched). `merge` upserts on `(agent, model, effectiveFrom)` and
  keeps rules not mentioned in the file.
- At most 500 rules. Repeated `(agent, model, effectiveFrom)` triples inside one
  file are rejected with `422`.
- Success is `201 {rules}` with the resulting table. An export file re-imports
  as is with `mode: "replace"` and yields the same rules (ids are reassigned).

## Permissions

Group `server.pricing` (scope server). The Administrator role gets all four
automatically when the database is opened.

| Permission | Allows |
| --- | --- |
| `pricing.read` | View the price table and the Settings tab; read the unpriced list. |
| `pricing.edit` | Create, update and delete rules. |
| `pricing.import` | Import a pricing file. |
| `pricing.export` | Export the price table. |

The permission ids are mirrored in `ui/src/api/permissions.ts`.

## Where cost shows up

- `GET /api/workflows/:id` → `usage.costUsd`, `usage.unpricedSessions`, and per
  session `costUsd` + `costSource` (`hub` | `pricing` | `unpriced`).
- `GET /api/workflows` rows → `costUsd`, `costPartial`.
- `GET /api/stats` → `usage.costUsd`, `usage.unpricedSessions`.
- Dashboard: **Est. cost** KPI, **Est. cost** column in the workflows table, the
  cost line under each session's usage meter, and the **Settings** tab (needs
  `pricing.read`) holding the price table.
