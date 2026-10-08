# Remote Sync contract

**Implemented version:** `sync/v2` for remote resources; existing workflow
sync remains compatible with clients that only implement the original workflow
commands.

The server exposes every sync route under `/api/sync`. There are two distinct
authentication mechanisms:

| Caller | Credential | Routes |
| --- | --- | --- |
| Dashboard operator | Signed-in session cookie or JWT Bearer token | Operator routes described below |
| Target client | `Authorization: Bearer <client_token>` or `Target-Device v1` | `/api/sync/heartbeat`, `/commands`, `/events`, `/api/sync/catalog` |

`POST /api/sync/register` is the first-contact exception: it creates a
`client_id` and returns the client token. It is not an operator route.

Register and heartbeat also include an `owner` object for hub UI configuration.
This is display-only: it does not authorize dashboard APIs and is not stored
on `client_token`. Device scopes (`ingest:write`, `sync:write`) stay on the
device record and are never copied into `owner.permissions`.

A linked device (owner known from device-link) receives the owner's current
DB-role grants plus the same grouped catalogue as `/api/auth/me`. A legacy
unlinked client receives `owner: null`; the server does not invent a user.

On a multi-org server (`TARGET_MULTI_ORG=1`), every sync route is scoped to
the **device’s organization** (the org of the human who approved the link).
Operator JWT sessions see only clients, commands, remote workflows and catalog
in their own org. See [`docs/multi-org.md`](multi-org.md).

```json
{
  "client_id": "client-id",
  "client_token": "sync_…",
  "created_at": "2026-09-21T21:00:00.000Z",
  "owner": null,
  "server_capabilities": { "events": ["client.heartbeat", "command.ack", "…"] }
}
```

Linked register / heartbeat:

```json
{
  "ok": true,
  "server_time": "2026-09-21T21:00:05.000Z",
  "owner": {
    "id": "user-id",
    "permissions": ["client.read", "client.workflows.create"],
    "catalog": {
      "groups": [
        {
          "id": "client.remote",
          "scope": "client",
          "label": "Clients",
          "description": "View connected Target hubs and their client state",
          "permissions": [
            {
              "id": "client.read",
              "label": "View clients",
              "description": "View connected clients and their state"
            }
          ]
        }
      ]
    },
    "granted": { "groups": [] }
  },
  "server_capabilities": { "events": ["client.heartbeat", "command.ack", "…"] }
}
```

`owner.permissions` is resolved with `getAuthUserPermissions` from the current
role. `owner.catalog` is `getPermissionCatalog()`. `owner.granted` is the same
groups filtered to those ids. A role change is visible on the next heartbeat
without re-register or a new device secret. Clients that ignore unknown fields
keep working.

### `server_capabilities.events`

Register and heartbeat also return `server_capabilities.events`: the full list
of event types this server accepts on `POST /api/sync/events` (`EVENT_TYPES` in
`blueprint.mjs`). The hub must only emit types in this list. One unknown type
makes the whole batch fail with `400`, and since the hub retries that batch,
all event sync for the client stalls. Older servers omit the field.

Schedule series and archive events (D20) are stored in `sync_events` with their
payload unchanged and mirrored as below. Their payloads are permissive objects
at the batch level (unknown keys kept), so a malformed one never fails the
whole batch:

| Type | Handling | Payload |
| --- | --- | --- |
| `schedule.instance_created` | validated per event, then creates the instance (see below) | `series_id`, `previous_remote_id`, `name`, `scheduled_for`, `schedule`, `agent`, `sandbox`, `conversation_context`, `steps[]`, `tcp_selections`, `resource_selections` |
| `workflow.schedule_changed` | instance `schedule_state` / `next_run_at`; series `broken` / back to `active` / `cancelled` (a server cancel is never revived) | `series_id`, `state`, `next_run_at` |
| `schedule.run_missed` | stored as a series notice (listed on `GET /api/sync/schedule-series`) | `series_id`, `occurrences[]` |
| `schedule.run_skipped` | stored as a series notice | `series_id`, `reason`, `occurrence` (optional) |
| `workflow.archived` | sets `archived_at` (payload value, else receive time) | `archived_at` (optional); the workflow goes in the event `remote_id` |
| `workflow.unarchived` | clears `archived_at` | none required; the workflow goes in the event `remote_id` |

`schedule.instance_created` is judged per event before it is stored; its
rules and rejection reasons are in [Scheduled series](#scheduled-series).

The `foreign_remote_id` check below still applies: one of these events whose
`remote_id` belongs to another client is rejected.

## Client protocol

1. `POST /api/sync/register` with an optional `name` and `capabilities`.
2. Persist the returned `client_token` (legacy) or keep using the device
   credential (linked). Read `owner` for hub UI only.
3. Send `POST /api/sync/heartbeat` with `status: "idle" | "busy"` and updated
   capabilities whenever they change. Use the latest `owner` if present.
4. Poll `GET /api/sync/commands` with the client token, apply each command
   exactly once by `command.id`, then acknowledge it through
   `POST /api/sync/commands/:commandId/ack`.
5. Push events to `POST /api/sync/events`. Event `id` is per-client
   idempotency key: re-sending an already accepted id returns it in
   `duplicates` and does not apply the mirror again. The response is
   `{ accepted, rejected, duplicates }`. An event whose `remote_id` belongs
   to another client, or a `command.ack` for another client's command or for
   a command on another client's workflow, is neither
   stored nor mirrored and comes back in `rejected` as
   `{ "id": "…", "reason": "foreign_remote_id" }`. Unknown `remote_id`s are
   still accepted. With `TARGET_MULTI_ORG=1` another org's remote workflows
   live in a different DB file, so their ids are simply unknown to the caller.

Commands are queued per `remote_id`. Resource commands use an internal
per-client/per-domain channel, so changes in one resource domain remain
ordered without blocking workflow commands.

## Resource capabilities

Remote templates, TCP tools and RCI resource sets require `sync/v2` capability
negotiation. A compatible client advertises all of:

```json
{
  "capabilities": {
    "resources": {
      "version": 2,
      "templates": true,
      "tcp_tools": true,
      "resource_sets": true
    },
    "commands": [
      "template.upsert",
      "template.delete",
      "tcp-tool.upsert",
      "tcp-tool.delete",
      "resource-set.upsert",
      "resource-set.delete"
    ]
  }
}
```

Each operation requires its domain flag and exact command name. An older client
or partial implementation receives:

```json
{
  "error": "capability_unsupported",
  "detail": "Client does not support sync/v2 template.upsert",
  "required": {
    "resources_version": 2,
    "domain": "templates",
    "command": "template.upsert"
  }
}
```

with HTTP `409`. The server validates this before changing its mirror or
enqueuing a command.

## Resource mirror and payload

The server stores a separate mirror for each `(client_id, domain, resource_id)`
in SQLite table `remote_resources`. Domains in storage are `templates`,
`tcp_tools`, and `resource_sets`.

The resource payload is deliberately schema-forward-compatible:

```json
{
  "resource": {
    "id": "stable-hub-resource-id",
    "name": "Human-readable name",
    "data": { "hub_specific": "object payload" }
  }
}
```

`id`, `name`, and object-valued `data` are validated. The server preserves
`data` as JSON instead of pretending resource details are globally uniform
across Target hub versions.

## Operator resource API

All resource paths are scoped to one client; resources are never global.
These routes are API-only: the dashboard's Remote control tab no longer has a
per-client resources panel.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/sync/clients/:clientId/templates` | `client.read` |
| POST | `/api/sync/clients/:clientId/templates` | `client.templates.create` |
| PATCH | `/api/sync/clients/:clientId/templates/:resourceId` | `client.templates.edit` |
| DELETE | `/api/sync/clients/:clientId/templates/:resourceId` | `client.templates.delete` |
| GET | `/api/sync/clients/:clientId/templates/export` | `client.templates.export` |
| POST | `/api/sync/clients/:clientId/templates/import` | `client.templates.import` |
| GET | `/api/sync/clients/:clientId/tcp-tools` | `client.read` |
| POST | `/api/sync/clients/:clientId/tcp-tools` | `client.tcp-tools.create` |
| PATCH | `/api/sync/clients/:clientId/tcp-tools/:resourceId` | `client.tcp-tools.edit` |
| DELETE | `/api/sync/clients/:clientId/tcp-tools/:resourceId` | `client.tcp-tools.delete` |
| GET | `/api/sync/clients/:clientId/tcp-tools/export` | `client.tcp-tools.export` |
| POST | `/api/sync/clients/:clientId/tcp-tools/import` | `client.tcp-tools.import` |
| GET | `/api/sync/clients/:clientId/resource-sets` | `client.read` |
| POST | `/api/sync/clients/:clientId/resource-sets` | `client.rci.create` |
| PATCH | `/api/sync/clients/:clientId/resource-sets/:resourceId` | `client.rci.edit` |
| DELETE | `/api/sync/clients/:clientId/resource-sets/:resourceId` | `client.rci.delete` |
| GET | `/api/sync/clients/:clientId/resource-sets/export` | `client.rci.export` |
| POST | `/api/sync/clients/:clientId/resource-sets/import` | `client.rci.import` |

`POST` and `PATCH` use the resource payload above. For `PATCH`, the
`resource.id` must equal `:resourceId`. `DELETE` needs no request body.

`GET .../export` returns a downloadable bundle
`{ contract_version, domain, resources: [{ id, name, data }] }` (no secrets)
with `content-disposition: attachment`. `POST .../import` accepts that shape
(or `{ resources }`) and queues one upsert per resource; pass `Idempotency-Key`
to retry the same bundle. Import uses the same sync/v2 capability check as
create. Retired `remote.templates.manage` / `remote.tcp-tools.manage` /
`remote.rci.manage` IDs are not accepted.

The list response is:

```json
{
  "contract_version": "sync/v2",
  "resources": [{
    "clientId": "client-id",
    "domain": "templates",
    "id": "template-id",
    "name": "Audit",
    "data": {},
    "revision": 3,
    "updatedAt": "2026-09-19T18:00:00.000Z"
  }]
}
```

### Idempotent operator mutations

Pass `Idempotency-Key` when retrying a create, update, or deletion. The same
key for the same client/domain returns the original queued command with
`{ "idempotent": true }`; it does not enqueue a second command.

Successful mutations return a command such as:

```json
{
  "command": {
    "id": "resource_…",
    "type": "template.upsert",
    "remote_id": "resources:client-id:templates",
    "sequence": 1,
    "payload": { "resource": { "id": "template-id", "name": "Audit", "data": {} } },
    "status": "pending",
    "created_at": "2026-09-19T18:00:00.000Z"
  },
  "idempotent": false
}
```

## Resource commands and events

| Server command | Client event after application |
| --- | --- |
| `template.upsert` / `template.delete` | `template.upserted` / `template.deleted` |
| `tcp-tool.upsert` / `tcp-tool.delete` | `tcp-tool.upserted` / `tcp-tool.deleted` |
| `resource-set.upsert` / `resource-set.delete` | `resource-set.upserted` / `resource-set.deleted` |

Upsert command and event payloads use `{ resource }`. Delete payloads use
`{ "resource_id": "…" }`. Client events are sent in the normal envelope:

```json
{
  "events": [{
    "id": "client-unique-event-id",
    "type": "template.upserted",
    "payload": {
      "resource": { "id": "template-id", "name": "Audit", "data": {} }
    }
  }]
}
```

The server accepts an event id once, then updates the mirror. Duplicates are
reported but do not increment the mirrored resource revision.

## Workflow operator API

Workflow controls remain under:

- `GET /api/sync/clients` (`client.read`)
- `GET /api/sync/events` (`client.read`)
- `GET /api/sync/remote-workflows` and `/:remoteId` (`client.read`)
- `POST /api/sync/remote-workflows` (`client.workflows.create`)
- enqueue `step.add` / `step.edit` (`client.workflows.steps.add` / `.steps.edit`)
- delete, set context, run-selection, pause, TCP/RCI selection and leftover
  plan mutations (`client.workflows.manage`)
- start/resume/restart and step run/abort/continue (`client.workflows.execute`)
- schedule a remote workflow (`client.workflows.execute` and
  `client.workflows.manage`, see [Scheduled series](#scheduled-series))

`GET` list and detail include `tcp_selections` and `resource_selections` on
each remote workflow.

Clients report supported workflow commands through `capabilities.commands`.
Resource support is additional; it does not imply workflow support.

### Server catalog templates on remote workflows

`POST /api/sync/remote-workflows` accepts optional `template_id` (a server
catalog template, not a per-client remote resource). That also requires
`templates.read`. The server expands the template itself: `workflow.create`,
optional `workflow.set_context`, then one `step.add` per template step with a
unique `step_key` (`step-N`). It does **not** send `workflow.apply_template`.

`step.add` may include `notes`: `{ id?, content, theme? }` where `theme` is
`warning` | `success` | `neutral`. The hub copies those onto the local step.

To append later:

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/sync/remote-workflows/:id/steps/from-template` | `client.workflows.steps.add` and `templates.read` |

Body: `{ "template_id": "…" }`. Every template step is appended with a new
`step_key`. Template TCP/RCI selections are merged into the workflow
(union by id; `null` tool/resource names mean “all” and win).

Unknown `template_id` is `404 { "error": "unknown_template" }`.

### Server catalog TCP / RCI on remote workflows

| Method | Path | Permission |
| --- | --- | --- |
| PUT | `/api/sync/remote-workflows/:id/tcps` | `client.workflows.manage` and `tcp-tools.read` |
| PUT | `/api/sync/remote-workflows/:id/resource-sets` | `client.workflows.manage` and `rci.read` |

```json
{ "tcp_selections": [{ "tcpId": "…", "toolNames": ["status"] }] }
```

```json
{ "resource_selections": [{ "resourceSetId": "…", "resourceNames": null }] }
```

`toolNames` / `resourceNames` omitted, `null`, or `[]` means the whole
pack/set. Unknown catalog ids are `422 { "error": "unknown_tcp:<id>" }` or
`unknown_resource_set:<id>`. Names that are not on that catalog item are
dropped.

If the client lacks `resources.version === 2` plus the matching domain flag
and `tcp-tool.upsert` / `resource-set.upsert` in `capabilities.commands`, the
server returns `409 capability_unsupported` and does not persist the
selection.

### Upsert then `workflow.set_selection`

Applying a selection (PUT or template merge) saves it, then enqueues, on the
**workflow** `remote_id` sequence:

1. `tcp-tool.upsert` for each referenced server TCP (same id; payload
   `{ resource: { id, name, data: { tags, tools } } }`)
2. `resource-set.upsert` for each referenced resource set
   (`data: { tags, resources }`)
3. `workflow.set_selection` with the full `tcp_selections` /
   `resource_selections` arrays

Those upserts share the workflow pipeline so `claimPendingCommands` delivers
them before `set_selection`. Do not put catalog upserts on the
`resources:<client>:<domain>` channel when attaching them to a workflow.

The hub applies upserts with `origin = "server"` and keeps that id. Hub
PATCH/DELETE of a server-managed TCP or resource set returns `409 { "error":
"server_managed" }` unless the caller is the sync upsert/delete path. The
server does not store “context already injected”; the hub rejects
`workflow.set_selection` after context injection.

See `test/remote-workflow-templates.test.mjs`,
`test/remote-workflow-selections.test.mjs`, and
`test/sync-e2e-smoke.test.mjs`.

## Scheduled series

A schedule is a **series**: every execution is its own remote workflow (an
**instance**) pointing at it through `series_id`, and a series always has
exactly one armed instance, the next execution. The hub runs the schedule
(recurrence, grace window, missed/skipped runs); the server records what the
operator decided and mirrors what the hub reports. A series created here is
managed only by the server: the hub shows it read-only and answers local edits
with `409 server_managed`.

### Data

- `remote_schedule_series`: `id`, `client_id`, `name`, `spec_json`,
  `timezone`, `include_previous`, `state` (`active` | `cancelled` | `broken`),
  `created_by`, `created_at`, `updated_at`.
- `remote_workflows` gains `series_id`, `scheduled_for`, `schedule_state`
  (`armed` | `fired` | `missed` | `cancelled` | `broken`, as the hub reports
  it), `next_run_at`, `archived_at` and `created_by` (`server` for operator
  rows, `hub` for instances the hub cloned). All are included in the list and
  detail responses; the detail response also carries `series`.
- `remote_schedule_notices`: missed/skipped runs reported by the hub.

Migrations are additive and run on every organization database.

### Schedule body

```json
{ "spec": { "kind": "weekly", "days": [1, 3, 5], "time": "21:30" }, "timezone": "Europe/Madrid", "include_previous": true }
```

Validation mirrors `hub/schedule.ts` exactly (the hub re-validates and acks the
command `failed` on disagreement):

| Field | Rule |
| --- | --- |
| `spec.kind` | `once`, `daily` or `weekly` |
| `spec.at` | `once` only: local `YYYY-MM-DDTHH:mm` naming a real date (`2026-02-30` is refused) |
| `spec.time` | `daily` / `weekly` only: `HH:mm`, `00:00`–`23:59` |
| `spec.days` | `weekly` only: at least one, unique integers `0` (Sunday)–`6` |
| `timezone` | an IANA zone in `Intl.supportedValuesOf("timeZone")`, or one Intl accepts and reports back verbatim (`UTC`, links like `Asia/Calcutta`); wrong case and `GMT` aliases are refused |
| `include_previous` | boolean, default `true` |

Keys belonging to another kind are refused, not stripped. A `once` in the past
is not an error here: the hub reports it as missed.

### Operator endpoints

Scheduling requires **both** `client.workflows.execute` and
`client.workflows.manage` (the create itself still needs
`client.workflows.create`). Every endpoint is scoped to the caller's
organization: another org's workflows, clients and series are `404` / absent.

| Endpoint | Effect |
| --- | --- |
| `POST /api/sync/remote-workflows` with `schedule` | creates the series (`created_by: "server"`) and queues `workflow.set_schedule` **after** the create, context, step and selection commands; the response adds `series` and `schedule_command` |
| `PUT /api/sync/remote-workflows/:id/schedule` | full replace. Updates the workflow's live series in place (a `broken` one goes back to `active`); with no series, or a cancelled one, starts a new series with this workflow as its first instance. Queues `workflow.set_schedule` |
| `DELETE /api/sync/remote-workflows/:id/schedule` | queues `workflow.cancel_schedule` and marks the series `cancelled`; already cancelled → `200` with `command: null` |
| `GET /api/sync/schedule-series?client_id=` | series (all clients of the org without the filter) with their `instances` (oldest first) and recent `notices` (`client.read`) |

Errors, checked before anything is persisted:

| Status | `error` | When |
| --- | --- | --- |
| `400` | `errors[]` | invalid schedule body (`schedule.spec.time`, `timezone`, …) |
| `403` | `forbidden` | missing `client.workflows.execute` or `.manage` (`permission` names it) |
| `404` | `remote_workflow_not_found` / `client_not_found` / `schedule_not_found` | unknown (or other-org) workflow or client; DELETE on a workflow with no series |
| `409` | `remote_workflow_busy` | PUT while the workflow is `running`, `waiting` or `paused` (`status` included) |
| `409` | `remote_workflow_deleting` | PUT while the workflow is being deleted |
| `409` | `capability_unsupported` | the client does not list the command in `capabilities.commands`; `required: { command }` |
| `422` | `use_schedule_endpoint` | `workflow.set_schedule` / `workflow.cancel_schedule` sent through `POST …/commands`, which would arm the hub with no series row |

### Commands

Both address the **series**, not a workflow: by the time the hub applies one,
the instance the server last saw may already have fired and been replaced, so
the hub applies it to the series' current live instance. `remote_id` is the
workflow the operator acted on; for a new series it is the workflow that
becomes the first armed instance.

| Command | Payload |
| --- | --- |
| `workflow.set_schedule` | `series_id`, `spec`, `timezone`, `include_previous` |
| `workflow.cancel_schedule` | `series_id` |

### Events

The hub only sends these when the server lists them in
`server_capabilities.events`. See the table in
[`server_capabilities.events`](#server_capabilitiesevents) for what each one
mirrors.

#### `schedule.instance_created`

When an instance fires, the hub clones the next one under a `remote_id` it
generates and announces it with the deterministic event id
`instance-created:<remote_id>`, until the server confirms it.

The event is checked BEFORE it is stored (D19). It is accepted when the series
exists in the client's org, belongs to this client and is not cancelled, the event
`remote_id` is new, and `previous_remote_id` is an instance of the same series.
The server then creates the remote workflow (`created_by: "hub"`, `local_id`
pending, `schedule_state: "armed"`), its steps under the given `step_key`s
(already on the client) and its TCP/RCI selections, and marks the previous
instance `fired`. A resend of an accepted announcement is idempotent: the
event id comes back in `duplicates`. Otherwise it is rejected with one of these
reasons and nothing is written:

| Reason | When |
| --- | --- |
| `unknown_series` | no such series in this org |
| `foreign_series` | the series belongs to another client |
| `series_cancelled` | the series was cancelled on the server |
| `foreign_remote_id` | the `remote_id` belongs to another client |
| `remote_id_conflict` | the `remote_id` is this client's but not an instance of this series |
| `invalid_previous_remote_id` | `previous_remote_id` missing or not an instance of the series |
| `remote_id_required` / `invalid_payload` | no event `remote_id`; missing `series_id`/`name`, or empty/duplicate `step_key`s |

The hub treats a rejection as fatal for the series: it marks it `broken` with
a critical notice until the operator reschedules it.

See `test/schedule-series-db.test.mjs`, `test/schedule-validation.test.mjs`,
`test/remote-workflow-schedule.test.mjs`, `test/schedule-events.test.mjs` and
the scheduled-series smoke in `test/sync-e2e-smoke.test.mjs`.

## Catalog pull (`catalog-sync/v1`)

On-demand pull of the **server-owned** Agent Resources catalog onto a linked
hub. This is not the per-client remote-resource mirror (`sync/v2`) and is not
an operator dashboard route. `isOperatorSyncPath` returns false for
`/api/sync/catalog` so the request stays on `requireSyncClient`.

### `GET /api/sync/catalog`

**Auth.** Same as heartbeat / commands / events: `Target-Device v1` with
`sync:write`, or `Authorization: Bearer <client_token>` when linking mode is
not `required`. No session cookie. `401` when the credential is missing or
invalid (`unauthorized`, `device_not_registered_for_sync`,
`device_link_required`). `403 { "error": "owner_required" }` when the client
has no linked owner (legacy token clients, unlinked devices). `403 { "error":
"scope_forbidden" }` when the device lacks `sync:write`.

An old server that does not implement this route answers `404`; hubs map that
to `catalog_sync_unsupported`.

**Who can pull what.** `listSyncableCatalog(ownerUserId)`: the owner needs
`client.templates.sync` / `client.tcp-tools.sync` / `client.rci.sync` **and**
their role on the resource allowlist. Admin bypasses the allowlist. Empty
allowlist = admins only. See [rbac.md](rbac.md#catalog-sync-allowlists).

**Response.**

```json
{
  "contract_version": "catalog-sync/v1",
  "server_time": "2026-09-27T17:00:00.000Z",
  "owner_id": "user-id",
  "allowed": {
    "templates": true,
    "tcp_tools": true,
    "resource_sets": false
  },
  "templates": [{
    "id": "tpl-id",
    "name": "Release checklist",
    "updatedAt": "2026-09-27T16:00:00.000Z",
    "data": {
      "tags": ["release"],
      "steps": [{ "description": "Ship it" }],
      "tcpSelections": [{ "tcpId": "tcp-id", "toolNames": null }],
      "resourceSelections": [{ "resourceSetId": "rci-id", "resourceNames": null }]
    }
  }],
  "tcp_tools": [{
    "id": "tcp-id",
    "name": "Git",
    "updatedAt": "2026-09-27T16:00:00.000Z",
    "data": { "tags": [], "tools": [{ "name": "status", "tokens": { "TOKEN": "…" } }] }
  }],
  "resource_sets": []
}
```

`allowed` is the owner's three `client.*.sync` flags (true/false even when the
arrays are empty). Template `tcpSelections` / `resourceSelections` are
filtered to TCP and RCI ids that appear in the **same** response. TCP `tokens`
use the same shape as a workflow attach / `catalogTcpToResource` upsert — they
are not redacted the way dashboard export bundles are. `syncRoleIds` is never
included.

Hubs upsert the rows with `origin = "server"` and `sync_source` including
`catalog`. See `test/catalog-sync.test.mjs`.

### `GET /api/catalog/sync-roles`

Operator session route (cookie or JWT), not device-authenticated. Any of
`templates.edit`, `tcp-tools.edit`, or `rci.edit`. Returns
`{ "roles": [{ "id", "name" }] }` so the Agent Resources picker can assign
allowlists. `401` without a session; `403` without one of those edit
permissions.

## Errors

| Status | Meaning |
| --- | --- |
| `401` | Missing or invalid session/client token |
| `403` | Authenticated operator lacks the required permission, or a catalog pull has no linked owner (`owner_required`) |
| `404` | Client or remote workflow does not exist; an old server also 404s `GET /api/sync/catalog` |
| `409` | Capability unavailable, state conflict, or reused incompatible idempotency key |
| `422` | Joi validation failed; response includes `errors` |

See `test/remote-resources.test.mjs` for executable compatible-client,
legacy-client, validation, permission, queue, and idempotency examples.
