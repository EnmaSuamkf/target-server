# RBAC and dashboard accounts

The server authorizes every sensitive dashboard API request in the backend.
Hiding an action in the React UI is only a usability improvement; it is not an
authorization mechanism.

## Permission catalogue

Roles contain only these permission IDs. `db.mjs` (`PERMISSION_CATALOG` /
`getPermissionCatalog()`) is the application source of truth. Unknown strings
are rejected with a validation error. Client-scoped IDs use the `client.`
prefix; the older `remote.*` spellings are not live and are remapped on open
(see [Additive migration](#additive-migration)). Resource-domain `*.manage` IDs
(`remote.templates.manage`, `remote.tcp-tools.manage`, `remote.rci.manage`) are
retired; they were replaced by create / edit / delete / import / export.

### Server

| Permission | Group | Allows |
| --- | --- | --- |
| `activity.read` | Activity | Read all Activity, events, instances and workflows |
| `activity.read.own` | Activity | Read Activity, events, instances and workflows from hubs linked to this account |
| `users.read` | Users | Read dashboard accounts |
| `users.manage` | Users | Invite users and manage users/roles |
| `devices.link` | Devices | Approve or deny a device-link request in the browser. This assigns the approved hub to the signed-in authorized human; it is not a dashboard/device credential. |
| `devices.manage` | Devices | List and revoke linked device identities (and manage their lifecycle). This is separate from approving a one-time link. |
| `templates.read` | Templates | View workflow templates stored on this server (Agent Resources) |
| `templates.create` | Templates | Create workflow templates stored on this server |
| `templates.edit` | Templates | Edit workflow templates stored on this server |
| `templates.delete` | Templates | Delete workflow templates stored on this server |
| `templates.import` | Templates | Import workflow templates stored on this server |
| `templates.export` | Templates | Export workflow templates stored on this server |
| `tcp-tools.read` | TCP tools | View TCP packs stored on this server (Agent Resources) |
| `tcp-tools.create` | TCP tools | Create TCP packs stored on this server |
| `tcp-tools.edit` | TCP tools | Edit TCP packs stored on this server |
| `tcp-tools.delete` | TCP tools | Delete TCP packs stored on this server |
| `tcp-tools.import` | TCP tools | Import TCP packs stored on this server |
| `tcp-tools.export` | TCP tools | Export TCP packs stored on this server |
| `rci.read` | RCI | View RCI resource sets stored on this server (Agent Resources) |
| `rci.create` | RCI | Create RCI resource sets stored on this server |
| `rci.edit` | RCI | Edit RCI resource sets stored on this server |
| `rci.delete` | RCI | Delete RCI resource sets stored on this server |
| `rci.import` | RCI | Import RCI resource sets stored on this server |
| `rci.export` | RCI | Export RCI resource sets stored on this server |

These `templates.*` / `tcp-tools.*` / `rci.*` IDs are server-owned Agent Resources catalog permissions. They are distinct from the client-scoped `client.templates.*` / `client.tcp-tools.*` / `client.rci.*` IDs that gate per-client Remote resources.

### Activity scope

`activity.read` ("View all activity") sees every reporting row on this server.
`activity.read.own` ("View own activity") sees only rows whose `owner_user_id`
is the signed-in account. If a role has both, **all** wins: the request is
unrestricted. Missing both is `403 { "error": "forbidden", "permission": "activity.read.own" }`.

Ownership is `events.owner_user_id` / `instances.owner_user_id`. The server
sets that column from the linked hub's owner (device-link) when the data
arrives; it is never taken from the ingest body. Events ingested with
`TARGET_INGEST_TOKEN` (or open ingest) keep `owner_user_id` NULL. Those
unowned rows are visible only with `activity.read`. An `activity.read.own`
caller with no linked hubs sees an empty Activity dashboard. Ingest refuses
to mix a foreign `workflow_id` into another owner's history
(`rejected` with `reason: "workflow_owner_mismatch"`) and refuses token/open
ingest that impersonates a linked hub's `instance_id`
(`403 { "error": "instance_owned_by_device" }`). See
[`docs/device-linking-v1.md`](device-linking-v1.md).

`GET /api/workflows/:id` for a workflow outside that scope returns
`404 { "error": "unknown_workflow" }` (not 403), so foreign ids cannot be
enumerated. Queries that look up a workflow's full history by `workflow_id`
(plans, notes, usage, status) also filter `owner_user_id` in own-scope, so a
shared id cannot leak another account's payload.

The Activity tab is shown with either permission. Own-only sessions get a
visible "Showing only your activity" indicator.

### Client

| Permission | Group | Allows |
| --- | --- | --- |
| `client.read` | Clients | Read connected clients, their workflows and resources |
| `client.workflows.create` | Workflows | Create client workflows. Creating from a server catalog template also requires `templates.read`. |
| `client.workflows.steps.add` | Workflows | Add steps to client workflows. Appending a server catalog template also requires `templates.read`. |
| `client.workflows.steps.edit` | Workflows | Edit steps on client workflows |
| `client.workflows.manage` | Workflows | Delete client workflows, set conversation context, choose run selection, and attach server catalog TCP/RCI. Attaching TCP also requires `tcp-tools.read`; attaching RCI also requires `rci.read`. |
| `client.workflows.execute` | Workflows | Start, pause, resume and restart client workflows; run, abort or continue steps |
| `client.templates.create` | Templates | Create a client's templates |
| `client.templates.edit` | Templates | Edit a client's templates |
| `client.templates.delete` | Templates | Delete a client's templates |
| `client.templates.import` | Templates | Import a client's templates |
| `client.templates.export` | Templates | Export a client's templates |
| `client.templates.sync` | Templates | Pull server catalog templates onto a linked hub |
| `client.tcp-tools.create` | TCP tools | Create a client's TCP tools |
| `client.tcp-tools.edit` | TCP tools | Edit a client's TCP tools |
| `client.tcp-tools.delete` | TCP tools | Delete a client's TCP tools |
| `client.tcp-tools.import` | TCP tools | Import a client's TCP tools |
| `client.tcp-tools.export` | TCP tools | Export a client's TCP tools |
| `client.tcp-tools.sync` | TCP tools | Pull server catalog TCP packs onto a linked hub |
| `client.rci.create` | RCI | Create a client's resource sets |
| `client.rci.edit` | RCI | Edit a client's resource sets |
| `client.rci.delete` | RCI | Delete a client's resource sets |
| `client.rci.import` | RCI | Import a client's resource sets |
| `client.rci.export` | RCI | Export a client's resource sets |
| `client.rci.sync` | RCI | Pull server catalog resource sets onto a linked hub |

### Catalog sync allowlists

Each Agent Resources item (template, TCP pack, resource set) has a per-resource
sync role allowlist (`catalog_sync_roles`). A linked-hub owner can pull a
resource only when **both** are true:

1. their role includes the matching `client.*.sync` permission, and
2. their role id is on that resource's allowlist.

The protected `admin` role always receives every item in domains it can sync
(it still needs the `client.*.sync` IDs, which admin is seeded with). An empty
allowlist means nobody except admin. The allowlist is never included on
`GET /api/sync/catalog` or on catalog export bundles.

Operators pick roles in the Agent Resources editor. `GET /api/catalog/sync-roles`
returns `{ "roles": [{ "id", "name" }] }` for any of `templates.edit`,
`tcp-tools.edit`, or `rci.edit`.

See [Catalog pull (catalog-sync/v1)](remote-sync.md#catalog-pull-catalog-syncv1).

### Additive migration

Opening an older database remaps retired IDs without a separate upgrade step:

1. Live client IDs stored with the pre-rename `remote.` prefix are remapped
   one-to-one onto `client.` (for example `remote.read` → `client.read`,
   `remote.workflows.create` → `client.workflows.create`,
   `remote.templates.export` → `client.templates.export`). No `remote.*` row
   survives the open.
2. Retired `remote.templates.manage` / `remote.tcp-tools.manage` /
   `remote.rci.manage` rows expand to that domain's five `client.*` children,
   then the old rows are deleted.
3. Any role that already has workflow manage (`client.workflows.manage`, or
   `remote.workflows.manage` before the rename) also receives
   `client.workflows.create`, `client.workflows.steps.add` and
   `client.workflows.steps.edit`.
4. The system `admin` role is seeded with every current catalogue ID; unknown
   admin rows are dropped.
5. The SQLite `CHECK` on `auth_role_permissions.permission` is rebuilt so it
   accepts the new IDs and rejects the retired `*.manage` and `remote.*`
   strings.

The migration is additive and repeatable. Role create/update still rejects
unknown IDs.

## System administrator

Migration creates the protected role id `admin` (display name
`Administrator`) and assigns every catalogue permission. Existing users are
migrated to it, including legacy/empty assignments. This role cannot be edited
or deleted.

The server also prevents:

- deleting the last administrator, even when non-admin users remain;
- assigning the last administrator to another role;
- deleting an assigned custom role;
- deleting or changing the role of the currently signed-in user.

Changing a custom role's permissions or assigning a user another role increments
that user's `token_version`. Existing session tokens immediately become invalid
and return `401`.

## Account and role API

These routes require a session. `users.read` allows the user list; all mutation
routes and role routes require `users.manage`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/users` | List dashboard accounts |
| POST | `/api/auth/users` | Invite `{ email, role_id, activation? }` |
| PATCH | `/api/auth/users/:id` | Assign `{ role_id }` |
| DELETE | `/api/auth/users/:id` | Delete another account |
| POST | `/api/auth/users/:id/invite` | Resend a pending invitation |
| GET/POST | `/api/auth/roles` | List or create roles |
| PATCH/DELETE | `/api/auth/roles/:id` | Edit or delete a custom role |

Role create/update payload:

```json
{
  "name": "Fleet operator",
  "permissions": ["activity.read", "client.read"]
}
```

Invite example:

```json
{
  "email": "operator@example.com",
  "role_id": "role-uuid-from-api",
  "activation": { "password": true, "google": false }
}
```

`role_id` must exist. Omitting it preserves backwards compatibility by assigning
`admin`; the Users UI always sends the selected role explicitly.

## Session responses and denied access

`POST /api/auth/login`, `POST /api/auth/setup`, `POST /api/auth/reset-password`,
and `GET /api/auth/me` return `{ user, catalog }`. `GET /api/auth/roles` includes
the same `catalog` so the Users tab does not need a second source.

`user.permissions` is the granted ID list from the current database role — that
is what authorization and `hasPermission` use. `catalog.groups` is the full
closed vocabulary (scope, group id, labels, descriptions, permission entries)
for UI rendering. The catalog blob is not an authorization decision.

```json
{
  "user": {
    "id": "user-id",
    "email": "operator@example.com",
    "role": "role-id",
    "permissions": ["activity.read"]
  },
  "catalog": {
    "groups": [
      {
        "id": "server.activity",
        "scope": "server",
        "label": "Activity",
        "description": "View reporting data on this dashboard server",
        "permissions": [
          {
            "id": "activity.read",
            "label": "View all activity",
            "description": "View Activity and reporting data from every hub"
          },
          {
            "id": "activity.read.own",
            "label": "View own activity",
            "description": "View Activity and reporting data from your own linked hubs"
          }
        ]
      }
    ]
  }
}
```

The server resolves permissions from the current database role for each
request, not from a stale JWT claim and not from `catalog`.

| Response | Meaning | Integrator action |
| --- | --- | --- |
| `401 { "error": "unauthorized" }` | No valid session, expired token, or token version was revoked | Sign in again |
| `403 { "error": "forbidden", "permission": "…" }` | Session is valid but lacks that capability | Grant the named permission through a role |
| `409` | A safety invariant blocks the requested change | Do not retry blindly; preserve an administrator/role assignment |
| `422` | Request or role/permission payload is invalid | Correct the field errors |

The dashboard's Users tab appears only with `users.manage`. The Activity tab
appears with `activity.read` or `activity.read.own`; Remote Control is
similarly selected from current session permissions.
