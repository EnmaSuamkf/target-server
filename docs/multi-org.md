# Multi-organization (one server, many isolated orgs)

One `target-server` process can host many customer organizations. Each org has
its own SQLite file. A small **control plane** database maps emails, tokens and
devices to an org so a request is never taken from the body or `Host` header.

Without `TARGET_MULTI_ORG=1` the process still opens a control plane (for the
JWT secret and directories) but treats traffic as the implicit organization
`default`, whose DB is `TARGET_SERVER_DB`. Existing single-tenant installs keep
working.

Hub **wire contracts** (`device-link/v1`, `sync/v2`, ingest batches) are
unchanged.

## Architecture

```text
                    ┌─────────────────────────┐
                    │  control.db             │
                    │  organizations          │
                    │  identities             │
                    │  user_directory         │
                    │  token_directory        │
                    │  device_directory       │
                    │  device_link_requests   │
                    │  superusers             │
                    │  jwt_secret             │
                    │  platform_audit         │
                    └───────────┬─────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   org-acme.db            target-server.db        org-beta.db
   (org "acme")           (org "default")         (org "beta")
   auth, events,          existing install        auth, events,
   devices, catalog       after upgrade           devices, catalog
```

- **Control plane** (`TARGET_CONTROL_DB`, or `control.db` next to
  `TARGET_SERVER_DB`): org registry, pairing requests (org unknown until a
  human approves them), Superusers, human **identities** (one password / Google
  per email), **memberships** (`user_directory`: email + org_id; Superuser
  emails stay unique), and the HS256 JWT secret.
- **Org DB**: one file per organization (`org-<slug>.db` beside
  `TARGET_SERVER_DB` for orgs created from the dashboard; the default org keeps
  using `TARGET_SERVER_DB`). Roles, users, activity, devices, sync clients and
  catalog live only here.
- Request handlers run inside `runWithOrg(orgId, …)` (AsyncLocalStorage).
  `open()` never silently falls back to another tenant.

### Org resolution

The server picks an org from the **authenticated principal**, never from JSON
or the Host header.

| Request | How org is chosen |
| --- | --- |
| `POST /api/auth/login` or `forgot-password` | Superuser email → `default`. Else credentials are checked on the **identity**. One membership → that org. Several memberships → no org yet; client must `POST /api/auth/select-org` (membership-checked). `org_id` in the login JSON and the Host header are ignored. |
| `POST /api/auth/select-org` | Select token from login/Google **or** an existing human JWT. `org_id` must be a membership of that email (`403` otherwise, without naming other tenants). |
| `POST /api/auth/setup` or `reset-password` | `token_directory`: `org_id` NULL is Superuser; otherwise that org |
| Human JWT (`target_auth` / Bearer) | Superuser (`su: true`) → `default`. Else JWT `org` claim checked against a membership `(org_id, user_id)` |
| `Target-Device v1` | `device_directory[device_id]` |
| `Target-Link` (poll/consume) | Control-plane link request `org_id` once approved; pending requests have no org yet |
| `POST /ingest` or `POST /api/sync/register` with `TARGET_MULTI_ORG=1` | Device credential required (`401 device_link_required` otherwise) |

Unknown principals get `401` without naming organizations.

A JWT whose `org` claim is tampered (bad signature) or re-signed for another
org (directory mismatch) is `401`.

## Roles

These are different principals. See also [`docs/rbac.md`](rbac.md).

| | Organization Admin | Superuser |
| --- | --- | --- |
| Where | Each org DB: protected system role `admin` | Control-plane `superusers` (not a `PERMISSIONS` id) |
| Powers | Every org-scoped permission in that org | Create orgs and invite each org’s first Admin; no Activity/Users/Remote/Library in v1 |
| Login | Identity password/Google, then one org or an org picker | Same `/api/auth/login`; email is looked up in `superusers` first |
| Session | `{ role, permissions, org, organizations, … }` plus JWT `org` | `{ superuser: true, permissions: [], organizations: [] }` |

Custom roles exist **per org**. The same role id in org A and org B is not
shared. Last-admin guards are per org.

## Creating an organization

1. Set `TARGET_SUPERUSER_EMAIL` and complete the emailed setup link (no
   default Superuser password is ever seeded).
2. Sign in as Superuser. The dashboard shows only **Organizations**.
3. **Create organization**: name, kebab-case slug, first Admin email, and
   invite activation (password and/or Google — same defaults as Users).
4. The server, atomically:
   - validates slug (unique, lowercase kebab). Email must not be a Superuser
     and must not already be a member of **this** slug (the same person may
     already admin another org);
   - creates `org-<slug>.db` and runs migrations (this seeds the protected
     `admin` role);
   - inserts the first `auth_users` row as pending `admin`;
   - issues the invite in that org’s context;
   - writes directories, then the `organizations` row and `platform_audit`.
5. If anything fails before the org row exists, the org is not listed and a
   retry with the same slug succeeds (leftover files are removed).

API (Superuser only; everyone else `403`):

- `GET /api/platform/orgs` → `{ orgs: [{ id, slug, name, status, createdAt, userCount, deviceCount, … }] }`
- `POST /api/platform/orgs` `{ name, slug, admin_email, activation? }` → `201`
- `POST /api/platform/orgs/:id/admin-invite` resends while pending (`409` once active)
- `PATCH /api/platform/orgs/:id` `{ "status": "active" | "disabled" }` → `200 { org }`
  (same shape as a `GET` row). `404` unknown id; `409 { error: "default_org_protected" }`
  for `default`; `422 { errors }` for any other body. Audit `organization.disabled` /
  `organization.enabled` (only when the status actually changes).
- `DELETE /api/platform/orgs/:id` `{ "confirm_slug": "<slug>" }` →
  `200 { deleted: { id, slug, name, userCount, deviceCount, archivedTo: [paths] } }`.
  `404` unknown id; `409 { error: "default_org_protected" }` for `default`; `422`
  with `errors: [{ field: "confirm_slug", code: "confirm_slug_mismatch", … }]` when the
  typed slug does not match (or is missing). Audit `organization.deleted` with the same
  detail as the response. Effects are described in
  [Disabling and deleting an organization](#disabling-and-deleting-an-organization).

The first Admin completes `/setup` (or Google). If that email already has a
password on another org, the new membership is activated with the **same**
identity credentials (no second setup). The dashboard lists memberships on
`GET /api/auth/me` (`user.org`, `user.organizations`); with two or more, login
shows an org picker and the top bar can switch session org.

`admin@admin.com` (Organization Admin of `default`) never sees **Create
organization**. Only a Superuser session does.

## Disabling and deleting an organization

Superuser only, from the **Organizations** tab (per-row **Disable** / **Enable** and
**Delete**) or the API above. The `default` organization (it holds
`admin@admin.com` and `TARGET_SERVER_DB`) can be neither disabled nor deleted.

**Disable** sets `organizations.status = 'disabled'`; nothing is removed.

- Every request the server resolves to that org gets `403 { error: "org_disabled" }`:
  existing sessions, `/api/auth/me`, setup / reset links, and hub device credentials
  (ingest and sync). Superuser requests are never blocked.
- Login into it is refused (`403 org_disabled` when it is the email's only org). A
  member of several orgs signs in to the remaining active ones; the org picker and
  `user.organizations` never offer a disabled org, and `select-org` into it is `403`.
- **Enable** restores access with no data loss. Existing sessions work again.

**Delete** requires typing the slug (`confirm_slug`). It is not a hard delete:

1. One `BEGIN IMMEDIATE` control-plane transaction removes, in order, the org's
   `token_directory` rows (pending invite / reset links become invalid, `4xx`),
   `device_link_requests`, `device_directory` (its hubs get `401`), `user_directory`
   memberships (its sessions get `401`, never `500`), `identities` that are left with
   no membership and are not a Superuser, and finally the `organizations` row.
   Members of other orgs keep those memberships and credentials.
2. The org DB path is retired in-process so no in-flight request can re-create an
   empty `org-<slug>.db`, and its handle is closed.
3. `org-<slug>.db` (plus `-wal` / `-shm` when present) is **moved** to
   `deleted-orgs/` next to `TARGET_SERVER_DB`, named
   `org-<slug>-<YYYYMMDDTHHMMSSZ>.db[-wal|-shm]` (UTC). `TARGET_SERVER_DB` and
   `control.db` are never touched.
4. `platform_audit` gets `organization.deleted`; earlier audit rows are kept.

The slug is free again immediately: creating an org with it provisions a fresh DB.
To bring a deleted org back, restore the archived file to `org-<slug>.db` **and**
recreate its `organizations` row and directory entries (see Operations); deleting
the archive in `deleted-orgs/` is a manual, deliberate step.

## Memberships (one identity, many orgs)

Control-plane `CONTROL_SCHEMA_VERSION` 2 turns v1 `user_directory.email`
PRIMARY KEY into memberships `PRIMARY KEY (email, org_id)` and adds
`identities` (shared password / Google). Existing 1:1 rows copy as-is; **do
not wipe** production `control.db` / org files for this upgrade.

- Superuser emails stay exclusive (not an org membership). Login still checks
  `superusers` first.
- Devices stay one-org (approver’s current JWT org).
- Optional local reset if experimental files are messy: stop the process,
  delete `control.db`, `target-server.db`, `org-*.db` (and `-wal`/`-shm`),
  restart with `TARGET_SUPERUSER_EMAIL` to re-send Superuser setup. Not
  required to recreate Superuser unless you want that mailbox as an org
  member (forbidden while it remains Superuser).

## Superuser bootstrap (local vs Render)

There is never a seeded Superuser password. The same env var works everywhere;
only **how the setup mail is delivered** changes.

| | Local | Render (`targetworkflows.com`) |
| --- | --- | --- |
| Mail | `TARGET_MAIL_TRANSPORT=file` writes `.mail-outbox/*.eml` under the process cwd | Blueprint already uses `resend` + `TARGET_PUBLIC_URL=https://targetworkflows.com`. The setup link arrives in the real inbox. |
| Env | `TARGET_SUPERUSER_EMAIL=you@example.com` | Service → **Environment** → `TARGET_SUPERUSER_EMAIL` (Blueprint `sync: false`) |
| Disk | `TARGET_SERVER_DB` + `control.db` beside it | Keep both on the persistent disk: `TARGET_SERVER_DB=/var/data/target-server.db`, `TARGET_CONTROL_DB=/var/data/control.db` |
| After boot | Open the newest `.eml`, follow `/setup?token=…` | Open the Resend mail (From `noreply@targetworkflows.com`), follow `https://targetworkflows.com/setup?token=…` |
| UI | Sign in as that email. Header shows `· superuser`. Tab **Organizations**. | Same. Sign **out** of `admin@admin.com` first. |

While the Superuser is still pending, each process start **re-sends** the setup
mail. After activation, boot only logs `superuser … already activated`.

**Turning on isolation** (`TARGET_MULTI_ORG=1`) is a separate switch. It
requires `TARGET_DEVICE_LINKING_MODE=required` (boot exits otherwise) and
rejects unlinked hub ingest/sync. You can create orgs with only
`TARGET_SUPERUSER_EMAIL` set; enable `TARGET_MULTI_ORG=1` after devices are
linked. Do not put `TARGET_MULTI_ORG=1` in the Blueprint by default.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `TARGET_MULTI_ORG` | `0` | `1` turns on db-per-org isolation for ingest/sync and JWT wrapping. **Requires** `TARGET_DEVICE_LINKING_MODE=required` (boot exits otherwise). |
| `TARGET_CONTROL_DB` | `control.db` next to `TARGET_SERVER_DB` | Control-plane SQLite path |
| `TARGET_SUPERUSER_EMAIL` | _(empty)_ | Idempotent pending Superuser + setup mail. Never a seeded password. |
| `TARGET_DEFAULT_ORG_SLUG` | `default` | Slug written for organization id `default` on **first** boot. Changing it later does not rename an existing row. Lowercase kebab, max 64. |
| `TARGET_SERVER_DB` | `./target-server.db` | Default org file (pre-existing installs keep this path) |
| `TARGET_DEVICE_LINKING_MODE` | `legacy` | Must be `required` when `TARGET_MULTI_ORG=1` |

## Upgrade (existing single database)

On first boot of this code against an existing `TARGET_SERVER_DB`:

1. That file becomes organization id `default` (slug
   `TARGET_DEFAULT_ORG_SLUG` or `default`).
2. Migrations run additively (RBAC, device-link, catalog, …) as today.
3. `user_directory`, `device_directory` and unused invite/reset tokens are
   backfilled **idempotently**.
4. The JWT secret in `auth_meta` is copied into the control plane once, so
   existing sessions keep verifying.
5. Legacy unlinked sync clients and `NULL` `owner_user_id` events stay in
   that org.

Switching `TARGET_MULTI_ORG=1` on later does the same backfill; ingest/sync
then require a linked device.

`test/upgrade-default-org.test.mjs` builds a pre-change schema file, boots
with `TARGET_MULTI_ORG=1`, and checks login, Activity, a linked device, a
legacy client, and a pre-change JWT.

## Operations

**Backup / restore** is per file:

- Control plane: `TARGET_CONTROL_DB` (or `control.db`).
- Default org: `TARGET_SERVER_DB`.
- Other orgs: `org-<slug>.db` (and `-wal` / `-shm` if present) next to it.
- Deleted orgs: archived files in `deleted-orgs/` next to `TARGET_SERVER_DB`.

Restore an org file only together with the matching `organizations` row and
directory entries, or the process will not route users/devices to it.

**Device org** = the org of the human who **approved** the link (see
[`docs/device-linking-v1.md`](device-linking-v1.md)). Sync and ingest for that
credential stay in that org ([`docs/remote-sync.md`](remote-sync.md)).

Dedicated one-customer Render services remain supported
([`docs/tenant-provisioning.md`](tenant-provisioning.md)). On a shared server,
create an org from the Superuser dashboard instead of a new Web Service.

## Limitations (out of scope for v1)

- Superuser impersonation of an org Admin
- Export an organization
- Per-org quotas (users, devices, storage)
- Superuser Activity / Users / Remote / Library UI (Organizations tab only)
- Choosing the org from Host / subdomain (resolution is identity-only)

## Implementation notes

Changed in this workflow (uncommitted on `main`; HEAD remains `7e2634b`):

- **Control plane:** `control-plane.mjs` (organizations, directories, Superusers, JWT secret, pairing rows, `TARGET_DEFAULT_ORG_SLUG`).
- **Storage:** `db.mjs` (`runWithOrg` / ALS `open()`, directory sync, per-org roles, `NONE_ROLE_ID`, default-org backfill, cross-org link-request guard).
- **Auth / HTTP:** `auth.mjs` (JWT `org` / `su` claims, `requireSuperuser`); `server.mjs` (request-boundary resolution, platform org API, Superuser bootstrap, invite org name); `blueprint.mjs` (`platform.org.create`); `mail-templates.mjs` (org name on invites).
- **UI:** `ui/src/App.tsx` Superuser Organizations shell; `ui/src/components/OrganizationsPanel.tsx`; `ui/src/api/platform.ts`; `ui/src/api/types.ts`; `ui/src/styles/global.css`.
- **Tests:** … `test/org-memberships.test.mjs`, `test/upgrade-default-org.test.mjs`, …
- **Docs:** this file (memberships + org switch, local vs Render Superuser bootstrap); `README.md`; `docs/rbac.md`; `docs/device-linking-v1.md`; `docs/remote-sync.md`; `docs/tenant-provisioning.md`; `render.yaml`. Other files in the working tree come from earlier phases of the same uncommitted work.

Phase 7: human **identities** (`identities` table) plus memberships; login
returns `selectOrg` when memberships > 1; `POST /api/auth/select-org` checks
membership; `/api/auth/me` includes `org` and `organizations`; UI picker and
top-bar switcher. Password/Google live on the identity and are replicated to
each org `auth_users` row so hashes do not drift.

Deviations from the original plan:

- Superuser setup/login/reset resolve from control-plane directories even when `TARGET_MULTI_ORG` is off, so a Superuser-created org’s first Admin can finish invite setup without wrapping `default`.
- `PATCH /api/auth/roles/:id` returns **404** `role_not_found` (not 409) when the role is absent in the current org, so a foreign id is not distinguishable from missing.
- Approving a device-link request that already has another org’s `org_id` is **404** `link_request_not_found`.
- Hub ingest of another org’s `workflow_id` string is accepted only into the **caller’s** org DB (the source org file is unchanged); isolation tests assert the source file, not a global unique workflow id.
- Default org **id** stays `default`; only the **slug** is configurable via `TARGET_DEFAULT_ORG_SLUG` on first insert.
- Phase 7 uses a control-plane `identities` table (option a) rather than only replicating hashes, and still copies password/Google onto each org `auth_users` row so existing per-org reads stay consistent.
