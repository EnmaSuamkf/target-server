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

## Template bundles

A template's command step names its pipeline by `pipelineId`, a row id that exists
only on the server that made it. A template exported to another server or hub
would therefore arrive with a dead reference. A **version 2** bundle carries the
YAML of every pipeline its command steps use, so the import can resolve each one
on the receiving side. `GET /api/templates/export` writes version 2.
`POST /api/templates/import` (permission `templates.import`) reads version 1 and
version 2. It is the bundle format the Target hub writes and reads. The
Limitations below list where the server's answer differs from the hub's.

### The version 2 shape

```json
{
  "kind": "target.templates",
  "schemaVersion": 2,
  "exportedAt": "2026-11-13T10:00:00.000Z",
  "pipelines": [
    {
      "ref": "p1",
      "name": "verify",
      "tags": ["ci"],
      "source": "name: verify\nsteps:\n  - name: Install\n    run: npm ci\n",
      "sourceHash": "<SHA-256 of source, 64 hex characters>"
    }
  ],
  "templates": [
    {
      "name": "Release",
      "tags": [],
      "steps": [
        { "kind": "command", "description": "Verify", "pipelineRef": "p1", "pipelineInputs": {} },
        { "description": "Review the result", "acceptanceCriteria": "All checks pass" }
      ],
      "tcpIds": [],
      "tcpSelections": [],
      "resourceSelections": []
    }
  ]
}
```

- `pipelines[]` lists each pipeline once, however many steps use it. `ref` is
  local to the file: `p1`, `p2`, … in order of first use.
- A command step carries `pipelineRef`, never `pipelineId`. The export drops
  `pipelineId`, because that id means nothing on another server.
- The export writes no `syncRoleIds`, organization id or server id.

### Import: hash resolution and sync roles

`POST /api/templates/import` reads every embedded pipeline before it writes
anything, then creates or reuses them, then creates the templates. All of it runs
in one transaction, so a refused bundle leaves nothing behind.

- **The hash is recomputed.** The server takes each pipeline's SHA-256 from its
  `source` text. The file's `sourceHash` is a label and is never trusted. The name
  is read from the YAML, not from the file's `name`.
- **An identical pipeline is reused.** A pipeline in the same organization with the
  same hash is reused. Its row, and its sync roles, stay exactly as they are.
- **Anything else is created with no sync roles.** The new pipeline has the text and
  tags from the file and `syncRoleIds: []`. It reaches no hub until an admin assigns
  roles to it. An import never grants roles.
- **Another organization's pipelines are never reused.** Resolution only looks at
  the importing organization's catalog.

### Import: response and warnings

`201 Created` returns:

```json
{
  "templates": [ { "id": "…", "name": "Release", "steps": [ … ] } ],
  "pipelines": [
    { "ref": "p1", "action": "reused", "pipeline": { "id": "…", "name": "verify", … } },
    { "ref": "p2", "action": "created", "pipeline": { "id": "…", "name": "other", "syncRoleIds": [], … } }
  ],
  "warnings": [
    { "code": "unresolved_pipeline", "template": "Release", "stepIndex": 3, "reason": "missing_ref" }
  ]
}
```

- `templates` is the list of templates created, as before.
- `pipelines` has one entry per embedded pipeline. `action` is `created` or
  `reused`, and `pipeline` is the local row.
- `warnings` do not stop the import. They say what it did not do exactly as written:

| Code | Fields | Meaning |
| --- | --- | --- |
| `pipeline_name_conflict` | `ref`, `name` | A pipeline with the same name but different text already exists. The file's text is created as its own pipeline. |
| `unresolved_pipeline` | `template`, `stepIndex`, `reason` | A command step has no pipeline. `missing_ref`: the step names no `pipelineRef`, or one missing from `pipelines[]`. `unknown_id`: a version 1 `pipelineId` is not in this organization. The template is still imported, and the step has no pipeline until one is chosen. `stepIndex` is the step's position in the bundle's `steps` array. |

### Import: errors

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{ "error": "invalid_pipeline", "errors": [ … ] }` | An embedded pipeline's YAML is not valid. Each problem has `line`, `path` (for example `pipelines[0].steps[0].shell`) and `message`. Nothing is written. |
| `400` | `{ "error": "unsupported_schema_version" }` | `schemaVersion` is greater than 2. This server cannot read it. |
| `422` | `{ "errors": [ … ] }` | The bundle does not match the template shape. |
| `422` | `{ "error": "invalid_template_step", "errors": [ … ] }` | A template fails the normal checks, for example an input the pipeline does not declare. The whole import is rolled back. |

### Version 1 compatibility

A version 1 envelope, a bare array of templates and a bare template still import.
They have no `pipelines[]`, so the rules above apply only to what they name:

- A version 1 command step's `pipelineId` is kept only when that row exists in
  this organization. A pipeline is never matched by name. Otherwise the step is
  reported with `unresolved_pipeline` and reason `unknown_id`.
- A version 2 step whose `pipelineRef` is missing from `pipelines[]` is reported
  with reason `missing_ref`.

### Standalone pipeline import

`POST /api/pipelines/import` uses the same hash rule. An entry whose text is
already in the organization is reused and is not copied again. Its response is:

```json
{
  "pipelines": [ { "id": "…", "name": "verify", … } ],
  "results": [ { "action": "reused", "pipeline": { "id": "…", "name": "verify", … } } ]
}
```

`pipelines` lists every entry, in order, reused entries included, as before.
`results` gives the same order, with `action` set to `created` or `reused`.
A reused pipeline keeps its roles. The `syncRoleIds` in the request apply only to
entries that are created.

### Limitations of the bundle

- An imported template keeps its name even when a template with that name already
  exists, so the list can show two templates with the same name. The hub renames
  such a copy `Clone - <name>`. The server does not.
- The `pipeline` object in a response is the server's full pipeline, with `source`
  and `syncRoleIds`. The hub returns a summary without them.
- A template import and a standalone pipeline import answer `201 Created`. The hub
  answers `200 OK` to both.
- Each entry in an import answer's `templates` is the server's template object,
  which carries `syncRoleIds` and `pipelineIds`. The hub returns a summary without
  them.

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
  `pipeline_id`, `pipeline_inputs`, `max_retries`, `retry_interval_seconds`,
  `use_subagent: false` and no acceptance criteria, plus `on_success_task` and
  `on_failure_task` when the step has branch agents. Without `kind`, an older hub
  would create an agent step.

The hub decides what to do with each pipeline (trust, revocation, the local-row
rule). That is in the hub design doc, under Phase 2.

## Branch agents

A template's command step can hold two agents (the hub design doc, "Branch
agents"): `onSuccessTask` runs when the pipeline passes, and `onFailureTask`
after each failed run, before the next retry. Each is only a task, with no
acceptance criteria and no judge. Blank means no agent, and the key is left out.

- The template store keeps both tasks and the command step's `maxRetries` and
  `retryIntervalSeconds` (it used to force the retries to 0). The template
  schema (`blueprint.mjs`) lists all four keys, because `stripUnknown` would
  otherwise drop them.
- The template editor shows "Agent on success" and "Agent on failure" under the
  pipeline fields.
- `step.add` and `step.edit` carry `on_success_task` and `on_failure_task`. A hub
  that predates branch agents ignores them and runs the pipeline alone.
- The workflow detail reads `on_success_task`, `on_failure_task` and
  `branch_failed` from the hub's `workflow.plan`, and keeps the phases
  `on_success` and `on_failure` (it used to fold every phase but `judge` into
  `exec`).

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
- The pipeline's name comes from the catalog when the server has the id, else from
  `pipeline_name` as the hub reports it. The hub sends `pipeline_name` on every
  command-step event (`data.pipeline_name`) and on each step of `workflow.plan`
  (`pipeline_name`). The snapshot's value wins; the latest step event's value is
  the fallback. A hub-local pipeline is not in the catalog, so its name is the
  only one there is. A hub that predates the field sends none, and an unknown id
  with no reported name gives `pipeline.name: null`. The server never puts the id
  in `name`. The id stays in `pipeline.id`.
- Its branch agents are drawn on the right of the card, where a judge would sit:
  a green-edged box for the on-success agent and a red-edged one for the
  on-failure agent, with a dashed retry loop from the failure box back into the
  card when the step has retries. A box lights while its agent runs, and the
  failure box shows the retry count. The step list shows the same two agents
  inside the card, and the status reads "agent: on success" or "agent: on
  failure" while one runs.
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
- `test/branch-agents.test.mjs`: the template keeps the branch tasks and the
  retries, the schemas keep them, `step.add` carries them, and the workflow
  detail exposes them from the plan.

## Limitations

- `workflow.create_with_steps` and the remote-step table carry no command fields,
  so a remote workflow's draft preview draws a command step as an agent step
  until the hub reports its plan.
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
