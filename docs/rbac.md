# RBAC and dashboard accounts

The server authorizes every sensitive dashboard API request in the backend.
Hiding an action in the React UI is only a usability improvement; it is not an
authorization mechanism.

## Permission catalogue

Roles contain only these permission IDs:

| Permission | Allows |
| --- | --- |
| `activity.read` | Read Activity, events, instances and workflows |
| `users.read` | Read dashboard accounts |
| `users.manage` | Invite users and manage users/roles |
| `remote.read` | Read Remote Control clients, workflows and resources |
| `remote.workflows.manage` | Create and edit remote workflows |
| `remote.workflows.execute` | Start, resume and restart remote workflows; run, abort or continue steps |
| `remote.templates.manage` | Manage a client's remote templates |
| `remote.tcp-tools.manage` | Manage a client's remote TCP tools |
| `remote.rci.manage` | Manage a client's remote resource sets |

`db.mjs` is the application source of truth for this closed catalogue. Unknown
permission strings are rejected with a validation error.

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
and `GET /api/auth/me` return a `user` containing:

```json
{
  "id": "user-id",
  "email": "operator@example.com",
  "role": "role-id",
  "permissions": ["activity.read"]
}
```

The server resolves permissions from the current database role for each
request, not from a stale JWT claim.

| Response | Meaning | Integrator action |
| --- | --- | --- |
| `401 { "error": "unauthorized" }` | No valid session, expired token, or token version was revoked | Sign in again |
| `403 { "error": "forbidden", "permission": "…" }` | Session is valid but lacks that capability | Grant the named permission through a role |
| `409` | A safety invariant blocks the requested change | Do not retry blindly; preserve an administrator/role assignment |
| `422` | Request or role/permission payload is invalid | Correct the field errors |

The dashboard's Users tab appears only with `users.manage`; Activity and Remote
Control are similarly selected from current session permissions.
