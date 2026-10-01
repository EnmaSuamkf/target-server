# Token pricing: handover

Branch `feat/token-pricing`. Full reference: [`pricing.md`](pricing.md). This page
is the short version for whoever picks it up next.

## What was built

**Phase 1: real cost**
- Per-organization price table (`pricing_rules`, additive migration) with the
  `/api/settings/pricing` API (CRUD, export, import) and `pricing.read|edit|import|export` permissions.
- Cost computed **at read time** from the last `usage.snapshot` per session,
  priced over four buckets (uncached input, cache write, cache read, output).
  Nothing is stored on events, so editing a rule reprices history.
- Dashboard: **Settings** tab (price table, unpriced-usage list), **Est. cost**
  KPI, **Est. cost** column in the workflows table, cost line per session.

**Phase 2: hub fields (server side)**
- Works with today's payload (`model` and `cost_usd` null, no `agent`).
  Uses `model` and `agent` from the snapshot as soon as the hub sends them; the
  hub's own `cost_usd` wins when numeric.

**Phase 3: estimates**
- `GET /api/pricing/estimate?templateId=&agent=&model=&steps=`: p50/p90 of
  completed, priced past runs, basis `template` → `agent_model` → `agent`,
  `insufficient_data` below 3 samples.
- `remote_workflows.template_id` now records the template a workflow was created
  from (the only reliable run-to-template link; runs created earlier have none).
- Estimate range shown in the remote-workflow create form and in the schedule
  editors (per run), only for users with `pricing.read`.

## Loading a pricing file

Settings tab → **Import JSON** (needs `pricing.import`), pick the file, choose
**Replace all rules** or **Merge**. Or via API:

```
curl -X POST $BASE/api/settings/pricing/import -H "cookie: $SESSION" \
  -H 'content-type: application/json' -d @pricing.json
```

`mode` defaults to `replace`. An export (`GET /api/settings/pricing/export`)
re-imports as is.

## Sample pricing file

**The numbers below are placeholders to show the format, NOT current list
prices.** Provider prices change; copy the real ones from the provider's pricing
page before using them. Units are USD per million tokens.

```json
{
  "kind": "target.pricing",
  "mode": "replace",
  "rules": [
    {"agent": "claude", "model": "*", "inputPerMtok": 3, "outputPerMtok": 15,
     "cacheReadPerMtok": 0.3, "cacheWritePerMtok": 3.75, "effectiveFrom": ""},
    {"agent": "claude", "model": "example-large-*", "inputPerMtok": 15, "outputPerMtok": 75,
     "cacheReadPerMtok": 1.5, "cacheWritePerMtok": 18.75, "effectiveFrom": ""}
  ]
}
```

Today's hubs send `model: null`, so the `claude` / `*` rule is the one that
applies until the hub reports models.

## What depends on the hub workflow

The separate workflow in the `target` repo changes `usage.snapshot` to carry a
real **`model`** and an **`agent`**. Until it ships:
- sessions can match only `(agent, *)` rules (model `*`), and `agent` comes from
  the workflow's `workflow.created`/`workflow.updated` events;
- `agent_model` estimates cannot form (model is null), so estimates use the
  `agent` basis;
- the "Unpriced usage" list shows `not reported` as the model.

Nothing needs changing on this server when the hub ships; more specific rules
simply start to match.

## Verified end to end (temp DB)

Seeded workflow with an old-shape and a new-shape snapshot, no model, agent only
in `workflow.created`, rule `claude` / `*` at 15 / 75 / cache read 1.5 / cache
write 18.75: `/api/workflows`, `/api/workflows/:id` and `/api/stats` all report
`$197.11641` (old session 59.11641 + new session 138.00); export → replace-import
gives the same cost; `/api/pricing/estimate?agent=claude` answers
`insufficient_data` with one past run.

## Manual QA checklist

Settings tab (as admin, then as a user with each single permission):
- [ ] Tab appears only with `pricing.read`; absent otherwise.
- [ ] Empty table shows the "No pricing rules yet" message.
- [ ] **Add rule** (needs `pricing.edit`): saves; a duplicate agent/model/date shows
      "already exists"; a negative price is rejected.
- [ ] Edit and delete (confirmation shown); edit/delete/Add buttons hidden without `pricing.edit`.
- [ ] **Import JSON** present only with `pricing.import`; replace swaps the table, merge keeps other rules; invalid JSON shows an error.
- [ ] **Export** present only with `pricing.export`; downloads `pricing-export.json`.
- [ ] "Unpriced usage" lists (agent, model) pairs with no rule; **Add rule** prefills the form; the pair disappears after saving.

Cost display:
- [ ] Workflows table **Est. cost** is `-` for an unpriced workflow (never `$0.00`).
- [ ] A workflow with some unpriced sessions shows `>= $x` and a tooltip.
- [ ] KPI **Est. cost** matches the sum of the table; hint appears when sessions are unpriced.
- [ ] Workflow detail: each session shows cost and source (reported by hub / est. / no pricing rule).
- [ ] Edit a rule's price: the same workflow's cost changes on refresh.
- [ ] Add a rule with a later `effectiveFrom`: older runs keep the old price.

Estimates:
- [ ] With `pricing.read` and at least one rule, the create form shows
      "Estimated cost: … (based on N past runs)" or "Not enough history to estimate".
- [ ] Changing template/agent updates it after a short pause; nothing shows without `pricing.read` or with an empty price table.
- [ ] The schedule editor shows "Estimated cost per run" under "Next runs".
