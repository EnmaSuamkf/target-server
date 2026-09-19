# Device linking contract v1

**Status:** canonical implementation contract.  This document defines the
server API that the Target hub consumes; no endpoint below is implemented until
the corresponding migration, Joi schema, guards, audit trail and tests land.
It is deliberately separate from `sync/v2`: an authenticated device may use
the existing sync protocol, but a dashboard account is never a device
credential.

## Goals and actors

Linking is optional. A hub with no server, no network, an expired/revoked
link, or an unavailable server continues to own and run its local workflows,
templates, TCP tools, RCI resources and report queue. Remote operations are an
enrichment only; the hub changes its remote state to `disconnected` or
`relink_required` and never deletes or blocks local data.

| Actor | Authentication | May do |
| --- | --- | --- |
| Human operator | Existing dashboard session (`target_auth` cookie or human JWT) | Approve a link, list/revoke/rotate devices when its current DB role allows it |
| Hub/device | Device id, device secret and an Ed25519 request signature | Only its assigned reporting/sync routes and scopes |
| Unlinked hub | Short-lived pairing credential | Start, poll and consume *its own* pending request only |

The server resolves the human actor and permissions from `auth_users` and the
current role in SQLite.  It resolves the device and its owner from device
tables.  It must not accept `user_id`, email, owner id, `client_id`, or an
identity claim in an ingest/sync JSON payload as authorization.

## Device states

`pending` → `approved` → `active` is the normal flow. `pending` becomes
`expired` after its short TTL, and may be `denied` by the human. `active` may
be `rotating`, then `active` again on a successful rotation, or `revoked`.
`revoked`, `denied`, and `expired` are terminal for that link request; a hub
starts a fresh request to relink. A newly issued replacement credential
supersedes the prior active credential atomically.

The server persists: a stable random `device_id`; owner `auth_user_id`;
display metadata; public key; hash/version/status/timestamps for the active
device secret; last-seen time; and append-only audit records. It persists only
SHA-256 hashes of pairing credentials and device secrets, never their raw
values. Lists and audit responses never include either secret, signatures, or
raw request payloads.

## Transport and request signing

All endpoints use JSON and `Cache-Control: no-store`. Outside a loopback
origin, device linking and device-authenticated routes require an HTTPS
`TARGET_PUBLIC_URL`; HTTP is refused rather than merely warned about. Secrets
are sent only in request headers or JSON bodies, never paths, queries,
redirects, response logs, or server logs.

The v1 device credential is deliberately **not a Bearer credential**. At link
creation, the hub makes and locally protects an Ed25519 key pair. Every
device-authenticated request needs all of:

```text
Authorization: Target-Device v1 <device_id>.<device_secret>
X-Target-Date: 2026-09-19T18:40:00.000Z
X-Target-Nonce: random-128-bit-base64url
X-Target-Signature: base64url(ed25519-sign(
  "target-device-v1\n" + METHOD + "\n" + PATH_WITHOUT_QUERY + "\n" +
  SHA256_HEX(EXACT_REQUEST_BODY) + "\n" + X-Target-Date + "\n" +
  X-Target-Nonce + "\n" + device_id
))
```

The timestamp has a five-minute skew window. Nonces are stored per device for
at least that window and are single use. Signature verification is over the
public key stored for the active device. The server validates the secret in
constant time after lookup, verifies the signature, status and scope, then
updates last-seen. Thus theft of the stored secret alone is insufficient;
the key and secret must both be present. A URL query is excluded from the
signature because device API routes reject queries except documented paging
parameters; no secret-bearing request uses one.

The link handshake has a distinct `Target-Link` header (below), valid only for
its one pending request. It cannot call ingest, sync, or any dashboard route.

## Pairing flow

The hub generates its key pair before contacting the server. It may show a
local “Open browser to link” action, and opens the returned URL using the OS
browser. It does not ask for, store, or transmit a human password.

1. **Hub initiates** `POST /api/device-links/requests`.  This unauthenticated
   anti-abuse surface is rate-limited by source IP and a server-wide pending
   cap. It receives a request id, a browser URL containing that non-secret id,
   and a 256-bit single-use polling credential. The hub stores this credential
   only until completion/expiry.
2. **Browser obtains human approval.** `GET /link/device/<request_id>` renders
   a dashboard route. It requires a normal human login if no session exists;
   after login it returns to the same request. It displays the server origin,
   device name, public-key fingerprint, requested scopes and expiry. The URL
   contains neither polling credential nor device credential.
3. **Human approves or denies.** The browser posts using its same-site human
   session. The server attaches the authenticated user as owner, records an
   audit event, and changes only that request to `approved`/`denied`.
4. **Hub polls then consumes.** Polling says only `pending`, `approved`,
   `denied`, or `expired`. Once approved, the hub makes a separate atomic
   consume call. That call returns a device secret exactly once. The hub stores
   it alongside the private key in its existing protected local identity
   storage, then discards the polling credential. It immediately uses the
   signed device protocol to heartbeat/report/sync.

Browser approval is not a redirect containing a credential. A browser that
has not authenticated returns the usual login flow; no human session token is
ever given to the hub.

## Wire API

Paths and names follow the existing `/api/sync` JSON conventions, but linking
is isolated under `/api/device-links` so it cannot be confused with legacy
anonymous sync registration.

### 1. Initiate

`POST /api/device-links/requests`

```json
{
  "contract_version": "device-link/v1",
  "device_name": "Ada's workstation",
  "hub_version": "0.9.0",
  "public_key": { "algorithm": "ed25519", "value": "<base64url-32-byte-public-key>" },
  "requested_scopes": ["ingest:write", "sync:write"]
}
```

The server ignores/rejects owner/user fields. `device_name` is display-only.
`requested_scopes` must be a subset of the server's fixed device scope
catalogue; it does not grant dashboard permissions.

```json
{
  "request_id": "dlr_opaque_random_id",
  "state": "pending",
  "browser_url": "https://server.example/link/device/dlr_opaque_random_id",
  "polling_credential": "<redacted-256-bit-random-value>",
  "expires_at": "2026-09-19T18:50:00.000Z",
  "poll_after_seconds": 3
}
```

`request_id` is at least 128 random bits and is an opaque locator, not a
credential. `polling_credential` and the eventual device secret are at least
256 random bits from CSPRNG, URL-safe encoded, and each is stored hashed.
Pending requests expire after ten minutes, are single consume, and a new
request never revives an old one.

### 2. Poll and consume (hub only)

`POST /api/device-links/requests/:requestId/poll` and
`POST /api/device-links/requests/:requestId/consume` require:

```text
Authorization: Target-Link <polling_credential>
Content-Type: application/json
```

Their bodies are `{}`. The header is not logged. Poll is safe to retry:

```json
{ "request_id": "dlr_…", "state": "pending", "expires_at": "2026-09-19T18:50:00.000Z", "poll_after_seconds": 3 }
```

After approval:

```json
{ "request_id": "dlr_…", "state": "approved", "expires_at": "2026-09-19T18:50:00.000Z" }
```

Consume is one-use and returns this only over the authenticated TLS response:

```json
{
  "device": {
    "id": "dev_opaque_random_id",
    "status": "active",
    "scopes": ["ingest:write", "sync:write"],
    "credential_version": 1
  },
  "device_secret": "<redacted-256-bit-random-value>"
}
```

The hub must not print, persist in workflow configuration, or return either
secret to UI/telemetry. A retry after an uncertain consume result must treat
`409 consumed` as `relink_required`; it never causes the server to disclose a
second copy.

### 3. Human approval and denial

`POST /api/device-links/requests/:requestId/approve` with a human session and
permission `devices.link`; body is `{}`. `POST .../deny` has the same guard.
The endpoint uses the URL id only to select the pending record; authority is
the DB-resolved human session. An approval response contains safe metadata:

```json
{
  "request_id": "dlr_…",
  "state": "approved",
  "device": { "name": "Ada's workstation", "fingerprint": "ed25519:SHA256:…" }
}
```

`GET /api/device-links/devices`, `POST /api/device-links/devices/:deviceId/rotate`,
and `POST /api/device-links/devices/:deviceId/revoke` require
`devices.manage`. Rotation follows the same proof-of-possession headers and
requires a new public key in the JSON body; its one-time replacement secret is
returned only to the currently authenticated device. Revocation invalidates
all device-secret versions immediately, records actor/reason/timestamp, and
causes subsequent device calls to return `401 device_revoked`.

## Device use of ingest and sync

Linked hubs use `Authorization: Target-Device …` plus the signing headers for
the protected form of `POST /ingest`, `/api/sync/heartbeat`,
`/api/sync/commands`, command acknowledgements and `/api/sync/events`.
The server derives `instance_id`/`client_id` ownership from the device record:
it rejects a conflicting payload id with `403 device_identity_mismatch`, and
associates accepted records to the device's server-side owner. The body never
selects a human owner.

`sync:write` permits only the hub's own current sync client and event/ack
channels. `ingest:write` permits only its own reporting stream. Device scopes
never permit user, role, device management, or arbitrary dashboard APIs.

### Device-initiated remote disconnect

An active hub may call `POST /api/device-links/devices/self/disconnect` with
its `Target-Device` credential and the v1 `X-Target-Date`,
`X-Target-Nonce`, and `X-Target-Signature` proof over an empty JSON body.
The server rejects an invalid/expired signature or reused nonce with `401
invalid_device_proof`; the date window is five minutes and the nonce is
consumed once. There is no `device_id` payload or path
parameter: the server derives the only disconnectable identity from the
credential. Success is `200 { "device": { "id": "…", "status": "revoked" },
"idempotent": false }`; repeating the request with its known revoked
credential returns the same safe `200` with `"idempotent": true`. Invalid or
unknown credentials return `401`; a device lacking `sync:write` returns `403`.

Disconnect revokes every credential, archives associated sync clients, and
removes the identity from operational lists. Administrators with
`devices.manage` use `GET /api/device-links/devices?history=1` to include
archived devices and `GET /api/device-links/devices/:device_id/audit` to
inspect their redacted audit history. Audit/history endpoints with
administrator access retain the device and historical reports/events. Older
hubs simply never call this optional endpoint and continue under their
configured legacy/optional behavior. The hub must interpret its successful
disconnect or a later `401` as a remote-only state change: it must preserve all
local workflows, execution state, templates, TCP tools and RCI data.

### Presence and clean reinstalls

`status: active` means the linked identity has not been revoked; it does not
mean the hub is reachable. Device list responses also carry
`operationalStatus`, derived on the server from `lastUsedAt` and
`TARGET_DEVICE_ONLINE_TTL_MS` (default: 90 seconds): `online` only when a
device credential was used within the TTL, otherwise `offline`. Revoked
identities are `revoked` and omitted from operational lists unless
`history=1` is requested. Sync-client operator lists likewise expose only
recent active heartbeats.

A hub with wiped local data performs a fresh link and receives a new device
identity even if its owner, email, or display name match an older entry. The
older identity remains independently offline (or archived/revoked); the
server never merges identities based on names or accounts. Historical reports
and audit records remain attached to their original identity.

## Idempotency, limits, and errors

Initiation accepts `Idempotency-Key` (1–128 printable characters). Repeating
the same key, source policy and canonical request body during the pending TTL
returns the original request with `"idempotent": true`; reusing it for another
body returns `409 idempotency_conflict`. Approval/deny are idempotent when
they request the existing terminal outcome; competing contradictory outcomes
return `409 invalid_link_state`. Consume is intentionally not replayable.

Baseline limits are: 10 initiations/IP/15 minutes, 60 polls/request/15
minutes, and normal endpoint body limits. Implementations return
`429 {"error":"too_many_requests"}` with `Retry-After`; deployments may
lower these values and add proxy/WAF limits. Audit at minimum logs initiated,
approved, denied, expired, consumed, credential-rotated, revoked, failed
authentication (without credentials), actor/device ids, IP policy result and
timestamp.

| Status | Stable error/action |
| --- | --- |
| `401` | `unauthorized`, `invalid_link_credential`, `invalid_device_credential`, `invalid_device_signature`, `replay_detected`, or `device_revoked`; hub disconnects/relinks without touching local data |
| `403` | `forbidden` with required human permission, `scope_forbidden`, or `device_identity_mismatch`; do not retry blindly |
| `404` | `link_request_not_found` or `device_not_found`; response reveals no extra identity data |
| `409` | `idempotency_conflict`, `invalid_link_state`, `already_consumed`, or conflicting approval/rotation |
| `422` | Joi field errors as `{ "error": "validation_failed", "errors": [{ "field", "code", "message" }] }` |

Malformed JSON remains `400`; wrong content type is `415`. Existing sync's
older validation status remains unchanged until its protected variant ships.

## Permissions and compatibility rollout

Add only these closed RBAC permissions:

| Permission | Purpose |
| --- | --- |
| `devices.link` | Approve or deny a pending device-link request |
| `devices.manage` | List device/audit metadata; rotate or revoke a device |

The protected `admin` role receives both through the additive RBAC migration.
Device scopes are not RBAC permissions and cannot be supplied by a client.

The implementation introduces an explicit deployment setting:
`TARGET_DEVICE_LINKING_MODE=legacy|optional|required`.

* `legacy` is the compatibility default. Existing `/ingest` and
  `/api/sync/register` behaviour is unchanged. New link endpoints are off.
* `optional` enables link endpoints and accepts both legacy integrations and
  linked devices. On a non-loopback bind, legacy ingest must have
  `TARGET_INGEST_TOKEN`; anonymous `/api/sync/register` is disabled unless an
  administrator explicitly enables a separately documented migration
  allowlist/registration secret.
* `required` accepts device-protected ingest/sync only. Legacy requests return
  `401 device_link_required`; a hub remains locally operational and tells its
  operator how to relink.

SQLite migrations are additive: device, credential-version, link-request,
nonce and audit tables coexist with `instances`, `clients`, `events`, and
`sync_events`. Existing client tokens are neither silently converted nor
assigned an owner. Operators first link/update hubs in `optional`, verify
linked traffic, then choose `required`; rollback to `optional` restores remote
compatibility without altering hub-local data.

## Implementation boundary

Proof of possession is part of v1, not a deferred hardening item. If a hub
release cannot generate/protect an Ed25519 key or sign requests, it must stay
in the explicit legacy/optional path; it must not treat `device_secret` as a
plain Bearer substitute. A future key algorithm/version requires a new
contract version and parallel verification, not silent downgrade.

## Hub implementation checklist

The Target hub workflow must implement and test the following against fixtures
for this exact `device-link/v1` document until both sides are deployed:

1. Generate and protect an Ed25519 key pair, initiate the request, open only
   `browser_url`, poll with `Target-Link`, then persist the one-time device
   secret outside UI/logs/configuration exports.
2. Sign every device-authenticated request with the canonical request format in
   this document. Do not treat the secret as a standalone Bearer credential.
3. In `optional`, preserve legacy traffic where configured. In `required`, map
   `401 device_link_required`, `device_revoked`, expiry and signature failures
   to remote-disconnected/relink-required without deleting or blocking any
   local workflow, execution, template, TCP or RCI data.
4. Test approval, denial, expiry, consume replay, network backoff and
   revocation with no real server/browser credentials. Redact `Authorization`,
   polling credentials and device secrets from every log, error, URL and UI.
