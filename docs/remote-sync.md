# Remote Sync API Contract

**Version:** `sync/v1`  
**Server:** Target Report Server (Node 24, port 8900 by default)  
**Status:** Design contract — endpoints described here are not yet implemented unless noted.

This document defines the hybrid push/pull protocol that lets a central Target server plan and control workflows on user machines running a local Target hub + AWB engine. The server enqueues **commands** (not full workflow blobs); clients poll, apply locally, and push **events** back.

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Authentication](#authentication)
3. [Common conventions](#common-conventions)
4. [Client endpoints](#client-endpoints)
   - [POST /sync/v1/clients/register](#post-syncv1clientsregister)
   - [POST /sync/v1/clients/heartbeat](#post-syncv1clientsheartbeat)
   - [GET /sync/v1/commands](#get-syncv1commands)
   - [POST /sync/v1/commands/:command_id/ack](#post-syncv1commandscommand_idack)
   - [POST /sync/v1/events](#post-syncv1events)
5. [Admin endpoints](#admin-endpoints)
   - [GET /api/sync/v1/clients](#get-apisyncv1clients)
   - [POST /api/sync/v1/clients](#post-apisyncv1clients)
   - [POST /api/sync/v1/clients/:client_id/revoke](#post-apisyncv1clientsclient_idrevoke)
   - [GET /api/sync/v1/workflows](#get-apisyncv1workflows)
   - [POST /api/sync/v1/workflows](#post-apisyncv1workflows)
   - [GET /api/sync/v1/workflows/:remote_id](#get-apisyncv1workflowsremote_id)
   - [POST /api/sync/v1/workflows/:remote_id/commands](#post-apisyncv1workflowsremote_idcommands)
   - [GET /api/sync/v1/workflows/:remote_id/commands](#get-apisyncv1workflowsremote_idcommands)
6. [Command lifecycle and sequencing](#command-lifecycle-and-sequencing)
7. [Idempotency](#idempotency)
8. [ID mapping and local metadata](#id-mapping-and-local-metadata)
9. [Conflict rules](#conflict-rules)
10. [Command types (server → client)](#command-types-server--client)
11. [Event types (client → server)](#event-types-client--server)
12. [Error code catalog](#error-code-catalog)
13. [Relationship to POST /ingest](#relationship-to-post-ingest)

---

## Architecture overview

```
┌─────────────────┐         push (register, heartbeat, events)          ┌─────────────────┐
│  Target Client  │ ──────────────────────────────────────────────────► │  Target Server  │
│  (local hub)    │ ◄────────────────────────────────────────────────── │  (central)      │
└─────────────────┘         pull (commands) + ack                       └─────────────────┘
```

| Direction | Mechanism | Purpose |
|-----------|-----------|---------|
| Client → Server | Push | Register, heartbeat, event batches |
| Server → Client | Pull | Poll pending commands (with claim/delivery) |
| Client → Server | Push | Ack command results, report workflow/step outcomes |

**Roles:**

- **Server** owns `remote_id` (server workflow identifier). It creates remote workflows and enqueues ordered commands.
- **Client** maps `remote_id` → local Target workflow id, executes commands against the local hub, and reports events.
- **Local-only workflows** (`origin: "local"`) never participate in sync.

---

## Authentication

Two auth domains, consistent with existing server patterns:

| Route prefix | Auth | Notes |
|--------------|------|-------|
| `/sync/v1/*` | Per-client token | `Authorization: Bearer <client_token>` — same header shape as `POST /ingest` |
| `/api/sync/v1/*` | JWT session | Dashboard operator; cookie or `Authorization: Bearer <jwt>` |

### Per-client token (sync routes)

- Issued at registration (`POST /sync/v1/clients/register`) or by an admin (`POST /api/sync/v1/clients`).
- Stored hashed server-side (same approach as ingest token verification).
- Scoped to one `client_id`; all sync requests must match the token's client.
- Revocable via admin endpoint.

**Request header (all `/sync/v1/*` routes except register):**

```http
Authorization: Bearer sync_7f3a9c2e1b4d8f6a0c5e3b9d2f1a8c7e
Content-Type: application/json
```

**Failure:** `401` with `{ "error": "unauthorized" }` — matches existing ingest behavior.

### Admin JWT (dashboard routes)

Uses the same JWT cookie/session as `/api/*`. Requires a signed-in operator with role `admin` or `operator` (exact RBAC TBD at implementation).

### Register exception

`POST /sync/v1/clients/register` is unauthenticated on first contact but may require a one-time **registration secret** (`registration_secret`) configured server-side via `TARGET_SYNC_REGISTRATION_SECRET`. When set, missing or invalid secrets return `403`.

---

## Common conventions

### Content type

All bodies are JSON. Requests without `Content-Type: application/json` receive `415`.

### Timestamps

ISO 8601 UTC strings, e.g. `"2026-09-13T21:00:00.000Z"`.

### Identifiers

| Field | Format | Owner |
|-------|--------|-------|
| `instance_id` | Stable string from local Target install | Client (reused from ingest) |
| `client_id` | Server-assigned UUID | Server |
| `remote_id` | Server-assigned UUID | Server |
| `command_id` | Server-assigned UUID | Server |
| `event_id` | Client-assigned UUID | Client |
| `local_workflow_id` | Local Target workflow id | Client (in events only) |

### Envelope fields (commands)

Every command returned by poll includes:

```json
{
  "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVWX",
  "type": "workflow.start",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 12,
  "created_at": "2026-09-13T21:00:00.000Z",
  "delivered_at": "2026-09-13T21:00:05.000Z",
  "payload": {}
}
```

### Success response shape

Unless noted, successful responses use HTTP `200` or `201` with a JSON object. Partial acceptance (events batch) uses `200` with `accepted` / `rejected` arrays, mirroring `POST /ingest`.

---

## Client endpoints

### POST /sync/v1/clients/register

Register (or re-register) a Target instance for remote sync. Returns a long-lived client token.

**Auth:** None, or registration secret in body when `TARGET_SYNC_REGISTRATION_SECRET` is configured.

**Request schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instance_id` | string | yes | Stable Target instance id (same as ingest) |
| `version` | string | yes | Target hub version, e.g. `"0.2.0"` |
| `display_name` | string | no | Human label |
| `capabilities` | object | no | Feature flags the client supports |
| `capabilities.commands` | string[] | no | Command types understood by this client |
| `capabilities.max_batch_events` | integer | no | Max events per push batch |
| `registration_secret` | string | conditional | Required when server enforces registration secret |

**Response `201`:**

| Field | Type | Description |
|-------|------|-------------|
| `client_id` | string | Server-assigned client identifier |
| `client_token` | string | Bearer token for all subsequent sync calls |
| `poll_interval_ms` | integer | Suggested command poll interval |
| `heartbeat_interval_ms` | integer | Suggested heartbeat interval |

**Example request:**

```json
{
  "instance_id": "inst_a1b2c3d4e5f67890",
  "version": "0.2.0",
  "display_name": "Ada — laptop",
  "capabilities": {
    "commands": [
      "workflow.create",
      "workflow.start",
      "step.add",
      "workflow.create_with_steps"
    ],
    "max_batch_events": 100
  }
}
```

**Example response:**

```json
{
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
  "client_token": "sync_7f3a9c2e1b4d8f6a0c5e3b9d2f1a8c7e",
  "poll_interval_ms": 3000,
  "heartbeat_interval_ms": 30000
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `403` | `{ "error": "registration_forbidden" }` | Invalid/missing registration secret |
| `422` | `{ "errors": [...] }` | Validation failure |
| `409` | `{ "error": "instance_already_registered", "client_id": "..." }` | Re-register without rotate flag (optional strict mode) |

---

### POST /sync/v1/clients/heartbeat

Push client liveness and availability. Server uses `status` to decide whether `workflow.start` may be assigned.

**Auth:** `Authorization: Bearer <client_token>`

**Request schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instance_id` | string | yes | Must match registered instance |
| `status` | string | yes | `"idle"` \| `"busy"` |
| `active_remote_ids` | string[] | no | Remote workflows currently running locally |
| `hub_version` | string | no | Current hub version |
| `sent_at` | string | yes | Client timestamp |

**Response `200`:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` |
| `server_time` | string | Server clock for skew detection |
| `next_heartbeat_ms` | integer | Suggested interval |

**Example request:**

```json
{
  "instance_id": "inst_a1b2c3d4e5f67890",
  "status": "idle",
  "active_remote_ids": [],
  "hub_version": "0.2.0",
  "sent_at": "2026-09-13T21:00:30.000Z"
}
```

**Example response:**

```json
{
  "ok": true,
  "server_time": "2026-09-13T21:00:30.042Z",
  "next_heartbeat_ms": 30000
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `401` | `{ "error": "unauthorized" }` | Invalid token |
| `422` | `{ "errors": [...] }` | Invalid body |

---

### GET /sync/v1/commands

Poll pending commands. Implements **claim-before-run**: matching commands transition `pending` → `delivered` atomically when returned.

**Auth:** `Authorization: Bearer <client_token>`

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | `10` | Max commands to return (max 50) |
| `types` | string | — | Comma-separated command type filter |

**Response `200`:**

| Field | Type | Description |
|-------|------|-------------|
| `commands` | command[] | Delivered commands in global sequence order |
| `cursor` | string \| null | Opaque cursor for long-poll / incremental fetch (optional) |

**Example request:**

```http
GET /sync/v1/commands?limit=5 HTTP/1.1
Authorization: Bearer sync_7f3a9c2e1b4d8f6a0c5e3b9d2f1a8c7e
```

**Example response:**

```json
{
  "commands": [
    {
      "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0",
      "type": "workflow.create",
      "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
      "sequence": 1,
      "created_at": "2026-09-13T21:00:00.000Z",
      "delivered_at": "2026-09-13T21:00:31.000Z",
      "payload": {
        "name": "Remote refactor",
        "workdir": "/home/ada/project"
      }
    },
    {
      "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW1",
      "type": "step.add",
      "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
      "sequence": 2,
      "created_at": "2026-09-13T21:00:01.000Z",
      "delivered_at": "2026-09-13T21:00:31.000Z",
      "payload": {
        "step_key": "step-1",
        "description": "Analyze codebase",
        "acceptance_criteria": "Summary written to notes",
        "manual_review": false
      }
    }
  ],
  "cursor": null
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `401` | `{ "error": "unauthorized" }` | Invalid token |

**Notes:**

- Commands for the same `remote_id` are strictly ordered by `sequence`.
- A client must not execute a command until it has been received from this endpoint (delivered).
- Re-polling after delivery returns the same command until acked or lease expires (see [Command lifecycle](#command-lifecycle-and-sequencing)).

---

### POST /sync/v1/commands/:command_id/ack

Acknowledge command execution result. Transitions command `delivered` → `acked` or `failed`.

**Auth:** `Authorization: Bearer <client_token>`

**Path parameters:**

| Param | Description |
|-------|-------------|
| `command_id` | Server command id |

**Request schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | yes | `"acked"` \| `"failed"` |
| `local_workflow_id` | string | no | Local id after create/map (required for `workflow.create*`) |
| `result` | object | no | Success payload (type-specific) |
| `error` | object | no | Required when `status` is `"failed"` |
| `error.code` | string | yes (if failed) | Application error code |
| `error.message` | string | yes (if failed) | Human-readable detail |
| `executed_at` | string | yes | Client timestamp |

**Response `200`:**

```json
{
  "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0",
  "status": "acked",
  "already_recorded": false
}
```

**Example success ack:**

```json
{
  "status": "acked",
  "local_workflow_id": "wf_local_abc123",
  "result": {
    "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
    "name": "Remote refactor"
  },
  "executed_at": "2026-09-13T21:00:32.500Z"
}
```

**Example failure ack:**

```json
{
  "status": "failed",
  "error": {
    "code": "workflow_not_found",
    "message": "No local mapping for remote_id rwf_missing"
  },
  "executed_at": "2026-09-13T21:00:33.000Z"
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `401` | `{ "error": "unauthorized" }` | Invalid token |
| `404` | `{ "error": "command_not_found" }` | Unknown command |
| `409` | `{ "error": "invalid_command_state", "detail": "already_acked" }` | Duplicate ack with conflicting body |
| `422` | `{ "errors": [...] }` | Validation failure |

**Idempotency:** Re-posting the same ack body for an already-acked command returns `200` with `"already_recorded": true`.

---

### POST /sync/v1/events

Push client events in batch (status changes, step results, completions). Separate from passive telemetry on `POST /ingest`.

**Auth:** `Authorization: Bearer <client_token>`

**Request schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instance_id` | string | yes | Must match registered instance |
| `batch_id` | string | yes | Client batch id for dedup |
| `sent_at` | string | yes | Client timestamp |
| `events` | event[] | yes | One or more events |

Each event:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | yes | Client-unique id |
| `type` | string | yes | Event type (see [Event types](#event-types-client--server)) |
| `remote_id` | string | conditional | Server workflow id |
| `local_workflow_id` | string | no | Local Target workflow id |
| `occurred_at` | string | yes | When the event happened on client |
| `payload` | object | yes | Type-specific data |

**Response `200`:**

```json
{
  "accepted": ["evt_001", "evt_002"],
  "rejected": [
    { "event_id": "evt_bad", "reason": "schema", "detail": "unknown type" }
  ]
}
```

**Example request:**

```json
{
  "instance_id": "inst_a1b2c3d4e5f67890",
  "batch_id": "batch_20260913_210035",
  "sent_at": "2026-09-13T21:00:35.000Z",
  "events": [
    {
      "event_id": "evt_001",
      "type": "workflow.created",
      "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
      "local_workflow_id": "wf_local_abc123",
      "occurred_at": "2026-09-13T21:00:32.500Z",
      "payload": {
        "name": "Remote refactor",
        "origin": "remote"
      }
    },
    {
      "event_id": "evt_002",
      "type": "workflow.status_changed",
      "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
      "local_workflow_id": "wf_local_abc123",
      "occurred_at": "2026-09-13T21:00:40.000Z",
      "payload": {
        "from": "pending",
        "to": "running"
      }
    }
  ]
}
```

**Example response:**

```json
{
  "accepted": ["evt_001", "evt_002"],
  "rejected": []
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `401` | `{ "error": "unauthorized" }` | Invalid token |
| `413` | `{ "error": "payload too large" }` | Body exceeds 5 MiB |
| `422` | `{ "error": "missing instance_id or events[]" }` | Invalid envelope |

---

## Admin endpoints

Dashboard operators use JWT auth to create remote workflows and enqueue commands. All paths under `/api/sync/v1/` require authentication unless auth is disabled for local dev (`TARGET_AUTH_DISABLED=1`).

### GET /api/sync/v1/clients

List registered sync clients and their last heartbeat.

**Auth:** JWT (admin/operator)

**Query:** `status=idle|busy|offline`, `limit`, `offset`

**Example response:**

```json
{
  "clients": [
    {
      "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
      "instance_id": "inst_a1b2c3d4e5f67890",
      "display_name": "Ada — laptop",
      "status": "idle",
      "last_heartbeat_at": "2026-09-13T21:00:30.000Z",
      "hub_version": "0.2.0",
      "capabilities": { "commands": ["workflow.create", "workflow.start"] }
    }
  ],
  "total": 1
}
```

---

### POST /api/sync/v1/clients

Admin-provision a client (alternative to self-registration). Returns token once.

**Auth:** JWT (admin)

**Request:**

```json
{
  "instance_id": "inst_a1b2c3d4e5f67890",
  "display_name": "CI runner",
  "assign_to_user_id": "usr_admin_001"
}
```

**Response `201`:**

```json
{
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVX0",
  "client_token": "sync_new_token_only_shown_once",
  "instance_id": "inst_a1b2c3d4e5f67890"
}
```

---

### POST /api/sync/v1/clients/:client_id/revoke

Revoke a client token. In-flight delivered commands may fail on client; server marks client offline.

**Auth:** JWT (admin)

**Example response:**

```json
{
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
  "revoked": true
}
```

---

### GET /api/sync/v1/workflows

List remote workflows managed by the server.

**Auth:** JWT

**Example response:**

```json
{
  "workflows": [
    {
      "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
      "name": "Remote refactor",
      "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
      "status": "running",
      "local_workflow_id": "wf_local_abc123",
      "created_at": "2026-09-13T21:00:00.000Z",
      "updated_at": "2026-09-13T21:00:40.000Z"
    }
  ],
  "total": 1
}
```

---

### POST /api/sync/v1/workflows

Create a remote workflow record and optionally enqueue initial commands atomically.

**Auth:** JWT

**Request:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Workflow name |
| `client_id` | string | no | Target client; if omitted, server picks idle client for start commands |
| `workdir` | string | no | Passed to `workflow.create` |
| `conversation_context` | string | no | Initial context |
| `commands` | command_enqueue[] | no | Additional commands enqueued after create |

**Example request:**

```json
{
  "name": "Remote refactor",
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
  "workdir": "/home/ada/project",
  "commands": [
    {
      "type": "step.add",
      "payload": {
        "step_key": "step-1",
        "description": "Analyze codebase"
      }
    }
  ]
}
```

**Example response `201`:**

```json
{
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "name": "Remote refactor",
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
  "enqueued_commands": [
    { "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0", "type": "workflow.create", "sequence": 1 },
    { "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW1", "type": "step.add", "sequence": 2 }
  ]
}
```

---

### GET /api/sync/v1/workflows/:remote_id

Remote workflow detail including command history summary.

**Auth:** JWT

**Example response:**

```json
{
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "name": "Remote refactor",
  "client_id": "cli_01J8XK2M3N4P5Q6R7S8T9UVWZ",
  "status": "running",
  "local_workflow_id": "wf_local_abc123",
  "origin": "remote",
  "commands_pending": 0,
  "commands_delivered": 1,
  "commands_acked": 5,
  "commands_failed": 0,
  "created_at": "2026-09-13T21:00:00.000Z",
  "updated_at": "2026-09-13T21:00:40.000Z"
}
```

---

### POST /api/sync/v1/workflows/:remote_id/commands

Enqueue one or more commands for a remote workflow.

**Auth:** JWT

**Request:**

```json
{
  "commands": [
    {
      "type": "workflow.start",
      "payload": {}
    }
  ]
}
```

**Example response `201`:**

```json
{
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "enqueued": [
    {
      "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW9",
      "type": "workflow.start",
      "sequence": 6,
      "status": "pending"
    }
  ]
}
```

**Error responses:**

| HTTP | Body | When |
|------|------|------|
| `404` | `{ "error": "remote_workflow_not_found" }` | Unknown `remote_id` |
| `409` | `{ "error": "no_idle_client", "detail": "workflow.start requires idle client" }` | Start assigned while client busy |
| `422` | `{ "errors": [...] }` | Invalid command type or payload |

---

### GET /api/sync/v1/workflows/:remote_id/commands

List commands for a remote workflow (admin debugging).

**Auth:** JWT

**Query:** `status=pending|delivered|acked|failed`

**Example response:**

```json
{
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "commands": [
    {
      "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0",
      "type": "workflow.create",
      "sequence": 1,
      "status": "acked",
      "created_at": "2026-09-13T21:00:00.000Z",
      "acked_at": "2026-09-13T21:00:32.500Z"
    }
  ]
}
```

---

## Command lifecycle and sequencing

### States

```
pending ──(poll claim)──► delivered ──(ack success)──► acked
                              │
                              └──(ack failed)──────────► failed
```

| State | Meaning |
|-------|---------|
| `pending` | Enqueued, not yet claimed by client |
| `delivered` | Returned by `GET /sync/v1/commands`; client must execute or fail |
| `acked` | Client reported success |
| `failed` | Client reported failure |

### Sequencing rules

1. Each `remote_id` has an independent monotonic `sequence` starting at 1.
2. The client **must** apply commands in sequence order per `remote_id`.
3. The server **must not** deliver command `N+1` until command `N` is `acked` or `failed` (per-workflow pipeline).
4. Cross-workflow commands for the same client may interleave in poll results but each workflow's sequence is preserved.

### Delivery lease

If a command stays `delivered` without ack longer than `TARGET_SYNC_COMMAND_LEASE_MS` (default 120000), the server may redeliver it on a subsequent poll. Clients treat duplicate delivery as idempotent by `command_id`.

### Client assignment

- `workflow.start` is enqueued only to clients whose latest heartbeat reports `status: "idle"`.
- Other commands may be delivered while `busy`, but the client may defer execution until appropriate.

---

## Idempotency

### Commands (`command_id`)

| Operation | Rule |
|-----------|------|
| Server enqueue | `command_id` is globally unique; duplicate enqueue requests with the same idempotency key return the original command |
| Client execution | Client stores processed `command_id` values; re-delivery is a no-op locally |
| Ack | Same `(command_id, status, result/error)` may be retried; server returns `already_recorded: true` |

**Admin idempotency header (optional):**

```http
Idempotency-Key: create-rwf-refactor-20260913
```

### Events (`event_id`, `batch_id`)

- Events are deduplicated by `(client_id, event_id)` — same pattern as ingest event dedup by `(instance_id, event.id)`.
- `batch_id` is logged for troubleshooting; redelivering the same batch with the same event ids does not double-apply.

### Registration

Re-registration with the same `instance_id` returns the existing `client_id` and rotates token only when `rotate_token: true` is sent (optional client flag).

---

## ID mapping and local metadata

The client maintains a mapping table in the local Target database:

| Column | Type | Description |
|--------|------|-------------|
| `origin` | `"local"` \| `"remote"` | Whether the workflow is server-controlled |
| `remote_id` | string \| null | Server workflow id; null for local-only |
| `remote_synced_at` | timestamp \| null | Last successful sync/ack timestamp |

**Resolution:** All commands reference `remote_id`. Before executing, the client resolves `remote_id` → `local_workflow_id`. If mapping is missing and the command is not `workflow.create*`, the client acks `failed` with `workflow_not_found`.

After `workflow.create` / `workflow.create_with_steps`, the client:

1. Creates the local workflow with `origin: "remote"` and `remote_id` set.
2. Acks with `local_workflow_id`.
3. Emits `workflow.created` event.

---

## Conflict rules

| Scenario | Resolution |
|----------|------------|
| Remote workflow edited locally | Server wins on next command; local edits to remote workflows may be overwritten |
| Local-only workflow | Never synced; server has no `remote_id` |
| Rename/delete on server | Client applies command; local state follows |
| Client offline | Commands stay `pending`; start commands wait for idle heartbeat |
| Duplicate local workflow for same `remote_id` | Client must not create duplicates; use mapping table |

---

## Command types (server → client)

All commands include top-level `command_id`, `type`, `remote_id`, `sequence`, and `payload`.

For step commands, `step_key` is a stable server-side step identifier mapped locally until the local `step_id` exists (client sends mapping in step-related events).

---

### workflow.create

Create a new local workflow bound to `remote_id`.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | yes |
| `workdir` | string | no |
| `agent` | string | no |
| `sandbox` | string | no |

**Example command:**

```json
{
  "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0",
  "type": "workflow.create",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 1,
  "created_at": "2026-09-13T21:00:00.000Z",
  "delivered_at": "2026-09-13T21:00:31.000Z",
  "payload": {
    "name": "Remote refactor",
    "workdir": "/home/ada/project"
  }
}
```

---

### workflow.delete

Delete the local workflow mapped to `remote_id`.

**Payload:** `{}` or optional `{ "force": true }`

**Example command:**

```json
{
  "command_id": "cmd_del",
  "type": "workflow.delete",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 99,
  "payload": {}
}
```

---

### workflow.rename

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_ren",
  "type": "workflow.rename",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 3,
  "payload": { "name": "Remote refactor v2" }
}
```

---

### workflow.set_context

Set conversation context on the local workflow.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `conversation_context` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_ctx",
  "type": "workflow.set_context",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 2,
  "payload": {
    "conversation_context": "Focus on the auth module only."
  }
}
```

---

### workflow.start

Start workflow execution. Server assigns only to idle clients.

**Payload:** `{}`

**Example command:**

```json
{
  "command_id": "cmd_start",
  "type": "workflow.start",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 10,
  "payload": {}
}
```

---

### workflow.pause

**Payload:** `{}`

**Example command:**

```json
{
  "command_id": "cmd_pause",
  "type": "workflow.pause",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 11,
  "payload": {}
}
```

---

### workflow.resume

**Payload:** `{}`

**Example command:**

```json
{
  "command_id": "cmd_resume",
  "type": "workflow.resume",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 12,
  "payload": {}
}
```

---

### workflow.restart

**Payload:** `{}` or `{ "preserve_context": false }`

**Example command:**

```json
{
  "command_id": "cmd_restart",
  "type": "workflow.restart",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 13,
  "payload": { "preserve_context": true }
}
```

---

### workflow.set_selection

Set TCP or resource selections on the workflow.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `tcp_selections` | object | no |
| `resource_selections` | object | no |

**Example command:**

```json
{
  "command_id": "cmd_sel",
  "type": "workflow.set_selection",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 4,
  "payload": {
    "tcp_selections": { "browser": "chromium" }
  }
}
```

---

### workflow.set_status

Set workflow status explicitly (admin override).

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `status` | string | yes |

Allowed values mirror local hub: `"pending"`, `"running"`, `"paused"`, `"completed"`, `"failed"`, etc.

**Example command:**

```json
{
  "command_id": "cmd_wst",
  "type": "workflow.set_status",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 20,
  "payload": { "status": "paused" }
}
```

---

### step.add

Add a step to the mapped local workflow.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `description` | string | yes |
| `acceptance_criteria` | string | no |
| `manual_review` | boolean | no |
| `use_subagent` | boolean | no |
| `order_index` | integer | no |

**Example command:**

```json
{
  "command_id": "cmd_add",
  "type": "step.add",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 5,
  "payload": {
    "step_key": "step-1",
    "description": "Analyze codebase",
    "acceptance_criteria": "Notes contain architecture summary",
    "manual_review": false
  }
}
```

---

### step.edit

Edit a pending step.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `description` | string | no |
| `acceptance_criteria` | string | no |
| `manual_review` | boolean | no |
| `use_subagent` | boolean | no |

**Example command:**

```json
{
  "command_id": "cmd_edit",
  "type": "step.edit",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 6,
  "payload": {
    "step_key": "step-1",
    "description": "Analyze codebase and list risks"
  }
}
```

---

### step.remove

Remove a pending step.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_rm",
  "type": "step.remove",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 7,
  "payload": { "step_key": "step-2" }
}
```

---

### step.move

Reorder a step.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `to_index` | integer | yes |

**Example command:**

```json
{
  "command_id": "cmd_move",
  "type": "step.move",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 8,
  "payload": { "step_key": "step-1", "to_index": 1 }
}
```

---

### step.run

Run (or re-run) a specific step.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_run",
  "type": "step.run",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 14,
  "payload": { "step_key": "step-1" }
}
```

---

### step.abort

Abort a running step.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_abort",
  "type": "step.abort",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 15,
  "payload": { "step_key": "step-1" }
}
```

---

### step.continue

Continue a step awaiting manual review.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `note` | string | no |

**Example command:**

```json
{
  "command_id": "cmd_cont",
  "type": "step.continue",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 16,
  "payload": { "step_key": "step-1", "note": "Looks good" }
}
```

---

### step.set_status

Force step status (admin).

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `status` | string | yes |

**Example command:**

```json
{
  "command_id": "cmd_sst",
  "type": "step.set_status",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 17,
  "payload": { "step_key": "step-1", "status": "pending" }
}
```

---

### workflow.create_with_steps

Batch sugar: create workflow and add steps in one command.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | yes |
| `workdir` | string | no |
| `conversation_context` | string | no |
| `steps` | array | yes |

Each step in `steps[]`: `step_key`, `description`, optional `acceptance_criteria`, `manual_review`, `use_subagent`, `order_index`.

**Example command:**

```json
{
  "command_id": "cmd_cws",
  "type": "workflow.create_with_steps",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 1,
  "payload": {
    "name": "Onboarding flow",
    "workdir": "/home/ada/app",
    "steps": [
      {
        "step_key": "step-1",
        "description": "Scan repository",
        "order_index": 0
      },
      {
        "step_key": "step-2",
        "description": "Write README section",
        "order_index": 1,
        "manual_review": true
      }
    ]
  }
}
```

---

### workflow.apply_template

Batch sugar: create workflow from a named server template.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `template_id` | string | yes |
| `name` | string | no |
| `workdir` | string | no |
| `variables` | object | no |

**Example command:**

```json
{
  "command_id": "cmd_tpl",
  "type": "workflow.apply_template",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "sequence": 1,
  "payload": {
    "template_id": "tpl_security_audit",
    "name": "Security audit — Q3",
    "workdir": "/home/ada/app",
    "variables": { "scope": "auth" }
  }
}
```

---

## Event types (client → server)

Events are pushed via `POST /sync/v1/events`. Types use dotted namespaced strings.

---

### client.heartbeat

Optional inline heartbeat when not using the dedicated heartbeat endpoint (e.g. combined sync loop).

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `status` | string | yes |
| `active_remote_ids` | string[] | no |

**Example event:**

```json
{
  "event_id": "evt_hb_001",
  "type": "client.heartbeat",
  "occurred_at": "2026-09-13T21:00:30.000Z",
  "payload": {
    "status": "idle",
    "active_remote_ids": []
  }
}
```

---

### command.ack

Mirror of HTTP ack for batched telemetry (optional; HTTP ack is authoritative).

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `command_id` | string | yes |
| `status` | string | yes |
| `error` | object | no |

**Example event:**

```json
{
  "event_id": "evt_ack_001",
  "type": "command.ack",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "occurred_at": "2026-09-13T21:00:32.500Z",
  "payload": {
    "command_id": "cmd_01J8XK2M3N4P5Q6R7S8T9UVW0",
    "status": "acked"
  }
}
```

---

### workflow.created

Local workflow created for a remote id.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | yes |
| `origin` | string | yes |
| `workdir` | string | no |

**Example event:**

```json
{
  "event_id": "evt_wc_001",
  "type": "workflow.created",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:00:32.500Z",
  "payload": {
    "name": "Remote refactor",
    "origin": "remote",
    "workdir": "/home/ada/project"
  }
}
```

---

### workflow.status_changed

Workflow status transition.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `from` | string | no |
| `to` | string | yes |

**Example event:**

```json
{
  "event_id": "evt_wsc_001",
  "type": "workflow.status_changed",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:00:40.000Z",
  "payload": {
    "from": "pending",
    "to": "running"
  }
}
```

---

### step.status_changed

Step status transition.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `local_step_id` | string | no |
| `from` | string | no |
| `to` | string | yes |

**Example event:**

```json
{
  "event_id": "evt_ssc_001",
  "type": "step.status_changed",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:01:00.000Z",
  "payload": {
    "step_key": "step-1",
    "local_step_id": "stp_local_xyz",
    "from": "pending",
    "to": "running"
  }
}
```

---

### step.result

Step finished with output summary (success or structured failure).

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `step_key` | string | yes |
| `local_step_id` | string | no |
| `outcome` | string | yes |
| `summary` | string | no |
| `usage` | object | no |

**Example event:**

```json
{
  "event_id": "evt_sr_001",
  "type": "step.result",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:05:00.000Z",
  "payload": {
    "step_key": "step-1",
    "local_step_id": "stp_local_xyz",
    "outcome": "success",
    "summary": "Architecture notes added",
    "usage": { "input_tokens": 1200, "output_tokens": 450 }
  }
}
```

---

### workflow.completed

All steps finished successfully.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `final_status` | string | yes |
| `step_count` | integer | no |

**Example event:**

```json
{
  "event_id": "evt_wdone_001",
  "type": "workflow.completed",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:30:00.000Z",
  "payload": {
    "final_status": "completed",
    "step_count": 2
  }
}
```

---

### workflow.failed

Workflow failed or was aborted.

**Payload:**

| Field | Type | Required |
|-------|------|----------|
| `reason` | string | yes |
| `failed_step_key` | string | no |
| `error` | object | no |

**Example event:**

```json
{
  "event_id": "evt_wfail_001",
  "type": "workflow.failed",
  "remote_id": "rwf_01J8XK2M3N4P5Q6R7S8T9UVWY",
  "local_workflow_id": "wf_local_abc123",
  "occurred_at": "2026-09-13T21:10:00.000Z",
  "payload": {
    "reason": "step_failed",
    "failed_step_key": "step-1",
    "error": {
      "code": "agent_error",
      "message": "Agent exceeded retry limit"
    }
  }
}
```

---

## Error code catalog

### HTTP status codes

| Code | Meaning | Typical `error` value |
|------|---------|------------------------|
| `400` | Malformed request | `invalid JSON`, `invalid_or_expired` |
| `401` | Missing/invalid auth | `unauthorized`, `invalid_credentials` |
| `403` | Forbidden | `registration_forbidden`, `forbidden` |
| `404` | Not found | `not_found`, `command_not_found`, `remote_workflow_not_found` |
| `409` | Conflict | `no_idle_client`, `invalid_command_state`, `instance_already_registered` |
| `413` | Body too large | `payload too large` |
| `415` | Wrong content type | `content-type must be application/json` |
| `422` | Validation failed | `errors: [...]` or `missing instance_id or events[]` |
| `429` | Rate limited | `too_many_requests` |
| `500` | Server error | `internal error` |
| `503` | Maintenance | `sync_disabled` |

### Application error codes (command ack / client errors)

| Code | Description |
|------|-------------|
| `workflow_not_found` | No local mapping for `remote_id` |
| `step_not_found` | Unknown `step_key` |
| `step_not_editable` | Step already started or completed |
| `context_locked` | Context cannot change after injection |
| `hub_unreachable` | Local Target hub not running |
| `agent_error` | AWB/agent execution failure |
| `capability_unsupported` | Client did not advertise command type |
| `precondition_failed` | e.g. start while already running |
| `internal_error` | Unexpected client-side failure |

### Validation error shape (422)

Matches existing `/api/auth/*` joi validation:

```json
{
  "errors": [
    {
      "field": "status",
      "code": "any.only",
      "message": "\"status\" must be one of [idle, busy]"
    }
  ]
}
```

---

## Relationship to POST /ingest

| Aspect | `POST /ingest` | Remote sync (`/sync/v1/*`) |
|--------|----------------|----------------------------|
| Purpose | Passive telemetry for dashboard analytics | Active remote control |
| Auth | `TARGET_INGEST_TOKEN` (shared) | Per-client token |
| Identity | `instance_id` | `instance_id` + `client_id` |
| Direction | Client push only | Push + pull |
| Workflow ids | Client `workflow_id` | Server `remote_id` + local mapping |
| Dedup | Event `id` | `command_id`, `event_id` |

Both channels may coexist. A single Target install uses the same `instance_id` for ingest and sync registration. Remote-controlled workflows should also emit ingest events for unified dashboard visibility (implementation detail on client).

---

## Environment variables (planned)

| Variable | Default | Meaning |
|----------|---------|---------|
| `TARGET_SYNC_REGISTRATION_SECRET` | _(empty)_ | If set, required in register body |
| `TARGET_SYNC_COMMAND_LEASE_MS` | `120000` | Redelivery timeout for delivered commands |
| `TARGET_SYNC_DISABLED` | `0` | If `1`, all `/sync/v1/*` return `503` |

---

## Typical client loop

1. `POST /sync/v1/clients/register` (once) → store `client_token`
2. Every 30s: `POST /sync/v1/clients/heartbeat`
3. Every 3s: `GET /sync/v1/commands` → execute → `POST /sync/v1/commands/:id/ack`
4. On state changes: `POST /sync/v1/events` (batch)
5. Continue passive `POST /ingest` for analytics (unchanged)

---

*Document generated for the target-server repository. Implementation should follow existing patterns in `server.mjs` (JSON helpers, joi validation, Bearer auth, SQLite persistence).*
