# RBAC and dashboard accounts

The server authorizes every sensitive dashboard API request in the backend.
Hiding an action in the React UI is only a usability improvement; it is not an
authorization mechanism.

## Permission catalogue

Roles contain only these permission IDs. `db.mjs` (`PERMISSION_CATALOG` /
`getPermissionCatalog()`) is the application source of truth. Unknown strings
are rejected with a validation error. Resource-domain `*.manage` IDs
(`remote.templates.manage`, `remote.tcp-tools.manage`, `remote.rci.manage`) are
not live; they were replaced by create / edit / delete / import / export.

### Server

| Permission | Group | Allows |
| --- | --- | --- |
| `activity.read` | Activity | Read Activity, events, instances and workflows |
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

These `templates.*` / `tcp-tools.*` / `rci.*` IDs are server-owned Agent Resources catalog permissions. They are distinct from the client-scoped `remote.templates.*` / `remote.tcp-tools.*` / `remote.rci.*` IDs that gate per-client Remote resources.

### Client

| Permission | Group | Allows |
| --- | --- | --- |
| `remote.read` | Remote Control | Read Remote Control clients, workflows and resources |
| `remote.workflows.create` | Workflows | Create remote workflows |
| `remote.workflows.steps.add` | Workflows | Add steps to remote workflows |
| `remote.workflows.steps.edit` | Workflows | Edit steps on remote workflows |
| `remote.workflows.manage` | Workflows | Delete remote workflows, set conversation context and choose run selection |
| `remote.workflows.execute` | Workflows | Start, pause, resume and restart remote workflows; run, abort or continue steps |
| `remote.templates.create` | Templates | Create a client's remote templates |
| `remote.templates.edit` | Templates | Edit a client's remote templates |
| `remote.templates.delete` | Templates | Delete a client's remote templates |
| `remote.templates.import` | Templates | Import a client's remote templates |
| `remote.templates.export` | Templates | Export a client's remote templates |
| `remote.tcp-tools.create` | TCP tools | Create a client's remote TCP tools |
| `remote.tcp-tools.edit` | TCP tools | Edit a client's remote TCP tools |
| `remote.tcp-tools.delete` | TCP tools | Delete a client's remote TCP tools |
| `remote.tcp-tools.import` | TCP tools | Import a client's remote TCP tools |
| `remote.tcp-tools.export` | TCP tools | Export a client's remote TCP tools |
| `remote.rci.create` | RCI | Create a client's remote resource sets |
| `remote.rci.edit` | RCI | Edit a client's remote resource sets |
| `remote.rci.delete` | RCI | Delete a client's remote resource sets |
| `remote.rci.import` | RCI | Import a client's remote resource sets |
| `remote.rci.export` | RCI | Export a client's remote resource sets |

### Additive migration

Opening an older database remaps retired IDs without a separate upgrade step:

1. `remote.templates.manage` / `remote.tcp-tools.manage` / `remote.rci.manage`
   rows expand to that domain's five children, then the old rows are deleted.
2. Any role that already has `remote.workflows.manage` also receives
   `remote.workflows.create`, `remote.workflows.steps.add` and
   `remote.workflows.steps.edit`.
3. The system `admin` role is seeded with every current catalogue ID; unknown
   admin rows are dropped.
4. The SQLite `CHECK` on `auth_role_permissions.permission` is rebuilt so it
   accepts the new IDs and rejects the retired `*.manage` strings.

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
  "permissions": ["activity.read", "remote.read"]
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
            "label": "View Activity",
            "description": "View Activity and reporting data"
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

The dashboard's Users tab appears only with `users.manage`; Activity and Remote
Control are similarly selected from current session permissions.
