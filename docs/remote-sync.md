# Remote Sync contract

**Implemented version:** `sync/v2` for remote resources; existing workflow
sync remains compatible with clients that only implement the original workflow
commands.

The server exposes every sync route under `/api/sync`. There are two distinct
authentication mechanisms:

| Caller | Credential | Routes |
| --- | --- | --- |
| Dashboard operator | Signed-in session cookie or JWT Bearer token | Operator routes described below |
| Target client | `Authorization: Bearer <client_token>` | `/api/sync/heartbeat`, `/commands`, `/events` |

`POST /api/sync/register` is the first-contact exception: it creates a
`client_id` and returns the client token. It is not an operator route.

Register and heartbeat also include an `owner` object for hub UI configuration.
This is display-only: it does not authorize dashboard APIs and is not stored
on `client_token`. Device scopes (`ingest:write`, `sync:write`) stay on the
device record and are never copied into `owner.permissions`.

A linked device (owner known from device-link) receives the owner's current
DB-role grants plus the same grouped catalogue as `/api/auth/me`. A legacy
unlinked client receives `owner: null`; the server does not invent a user.

```json
{
  "client_id": "client-id",
  "client_token": "sync_…",
  "created_at": "2026-09-21T21:00:00.000Z",
  "owner": null
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
  }
}
```

`owner.permissions` is resolved with `getAuthUserPermissions` from the current
role. `owner.catalog` is `getPermissionCatalog()`. `owner.granted` is the same
groups filtered to those ids. A role change is visible on the next heartbeat
without re-register or a new device secret. Clients that ignore unknown fields
keep working.

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
   `duplicates` and does not apply the mirror again.

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
- delete, set context, run-selection, pause and leftover plan mutations
  (`client.workflows.manage`)
- start/resume/restart and step run/abort/continue (`client.workflows.execute`)

Clients report supported workflow commands through `capabilities.commands`.
Resource support is additional; it does not imply workflow support.

## Errors

| Status | Meaning |
| --- | --- |
| `401` | Missing or invalid session/client token |
| `403` | Authenticated operator lacks the required permission |
| `404` | Client or remote workflow does not exist |
| `409` | Capability unavailable, state conflict, or reused incompatible idempotency key |
| `422` | Joi validation failed; response includes `errors` |

See `test/remote-resources.test.mjs` for executable compatible-client,
legacy-client, validation, permission, queue, and idempotency examples.
