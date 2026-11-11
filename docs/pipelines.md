# Pipelines in the server catalog

A **pipeline** is a YAML job (`run:` steps, the subset described in the hub's
design doc) stored in the organization's catalog. A workflow template may hold a
**command step** that runs one. The hub runs it on its host, with no agent. This
server never runs a pipeline. It stores the text, decides who may read or change
it, and syncs it to linked hubs.

The full design, the hub's rules and the trust model are in
[`../../target/docs/pipelines.md`](../../target/docs/pipelines.md). This page covers
the server side only.

## What the server stores

- A `pipelines` table in the organization's database: `id`, `name`, `tags`,
  `source` (the raw YAML), `source_hash` (SHA-256 of the text), and timestamps.
  There are no `created_by` or `updated_by` columns, as for TCP tools.
- `pipeline-yaml.mjs` is a line-for-line port of the hub's validator. The server
  validates pipeline text with the same rules, messages, line numbers and hash as
  the hub. Its header says it must stay in lockstep with the hub file.
- The conformance fixture `test/fixtures/pipeline-conformance.json` is
  byte-identical to the hub's `hub/fixtures/pipeline-conformance.json`. Both
  validators are tested against it, and a rule change changes both validators and
  both copies together.

## Permissions

The catalogue has six IDs, grouped as `client.pipelines`. They mirror
`client.tcp-tools.*`:

| Permission | Allows |
| --- | --- |
| `client.pipelines.create` | Create a pipeline; validate text |
| `client.pipelines.edit` | Edit a pipeline; validate text |
| `client.pipelines.delete` | Delete a pipeline that no step or template uses |
| `client.pipelines.import` | Import a pipeline bundle |
| `client.pipelines.export` | Export pipelines |
| `client.pipelines.sync` | Receive pipelines on a linked hub (the `allowed.pipelines` flag) |

Reads are open to anyone holding any of the six IDs. The UI shows the list to
them and disables the buttons they cannot use.

## Routes

| Route | Permission |
| --- | --- |
| `GET /api/pipelines`, `GET /api/pipelines/:id` | any of the six IDs |
| `POST /api/pipelines` | `client.pipelines.create` |
| `PATCH /api/pipelines/:id` | `client.pipelines.edit` |
| `DELETE /api/pipelines/:id` | `client.pipelines.delete`; `409 in_use` while a template uses it |
| `POST /api/pipelines/validate` | `client.pipelines.create` or `.edit`; saves nothing. Returns `{ ok, name, inputs, errors }` |
| `POST /api/pipelines/import`, `GET /api/pipelines/export`, `GET /api/pipelines/:id/export` | `client.pipelines.import` / `.export` |

Templates accept command steps: `{ "kind": "command", "pipelineId",
"pipelineInputs" }`. Saving one checks that the pipeline exists in the
organization and that its inputs match the declared ones. The rules are the
same as the hub's.

## Catalog sync

`GET /api/sync/catalog` (catalog-sync/v1) gains a fourth domain, `pipelines`,
with its own `allowed.pipelines` flag.

- **Capability gate.** A hub receives pipelines only if it advertises
  `resources.pipelines: true` on register and heartbeat, and its owner holds
  `client.pipelines.sync`. For any other hub, `allowed.pipelines` is `false`, the
  `pipelines` array is absent, and every template with a command step is omitted.
- **Per-item gate.** Items follow the same sync-role allowlist (`syncRoleIds`) as
  templates, TCP packs and resource sets. An admin receives every item.
- **Whole-template rule.** A template with a command step is withheld, not
  trimmed, when the hub cannot run pipelines or the owner is not granted every
  pipeline it runs. A hub never gets a template that does less than the server's
  copy.
- **Item shape.** `{ id, name, updatedAt, data: { tags, source, sourceHash } }`.
  The YAML is the pipeline. It carries no secret value: `${{ secrets.NAME }}`
  only names a secret the hub holds.
- **Remote workflows.** A server-side remote workflow built from a command-step
  template is refused with `409 capability_unsupported` for a hub without the
  capability, and with `409 pipeline_not_synced` (listing `pipelineIds`) when a
  pipeline is not granted to the hub's owner. Nothing is queued.
- **Command step on the wire.** A hub receives `step.add` with `kind: "command"`,
  `pipeline_id`, `pipeline_inputs`, `use_subagent: false` and no acceptance
  criteria. Without `kind`, an older hub would create an agent step.

The hub decides what to do with each pipeline (trust, revocation, the local-row
rule). That is in the hub design doc, under Phase 2.

## Migrations

Startup creates the `pipelines` table when it is missing. It also rebuilds the
`remote_resources` and `catalog_sync_roles` tables, whose `domain` CHECK
constraints did not yet list `pipelines`. SQLite cannot alter a CHECK, so the
rebuild creates a new table, copies every row with an explicit column list,
drops the old one and renames the new one, all in one transaction. It runs only
when the stored `CREATE` SQL lacks `'pipelines'`, so a second start changes
nothing. `test/pipelines-migration.test.mjs` covers this with a legacy database.

## Canvas and event feed

- The workflow canvas draws a command step as its own card: a terminal glyph and
  `Pipeline: <name>`. It never draws a subagent or judge node, whatever
  `useSubagent` or the acceptance criteria say.
- The event feed summarises `step.started`, `step.completed` and `step.failed`
  for command steps. It shows the pipeline name, the conclusion and each job step's
  name, status and duration. It never shows log content.

## Tests

- `test/pipelines-api.test.mjs`: CRUD, validation with lines, permission per ID,
  delete refused while referenced, import and export.
- `test/pipelines-migration.test.mjs`: the CHECK rebuild preserves rows, accepts
  `pipelines`, and is a no-op on a second run.
- `test/pipeline-conformance.test.mjs`: every fixture case, and the identity of
  the two fixture copies.
- `test/catalog-sync.test.mjs`: the capability gate, including the whole-template
  rule and a hub without the capability.

## Limitations

- The sync-role picker (`GET /api/catalog/sync-roles`) lists roles only for
  `templates.edit`, `tcp-tools.edit` or `rci.edit`. An editor holding only the
  pipeline rights cannot choose sync roles. An admin can.
- Two pipelines may share a name. Only the browser upload refuses a collision,
  and only on the client.
- The Pipelines panel fits a 390 px phone, but the page scrolls horizontally
  because of the existing top bar. The server UI has no dark theme.
- A server built before the `pipelines` capability existed rejects the key in
  the hub's capabilities. Ship the hub and server together, as the hub's
  open questions describe.
