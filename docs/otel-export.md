# OpenTelemetry export

Each organization can send its workflow activity to any OTLP backend
(Grafana, Datadog, Honeycomb, Langfuse, an OpenTelemetry Collector, ...) as
**traces and metrics over OTLP/HTTP JSON**. The destination is a plain
`endpoint` plus optional `headers` (usually an API key). Nothing is exported
until an organization turns it on, and only events received **after** that
moment are exported.

What each event becomes (span names, attributes, metric names, cost rules) is
defined in [observability/otel-mapping.md](observability/otel-mapping.md). This
page covers the settings API, storage, delivery and security.

Code: `otel.mjs` (mapping), `otel-client.mjs` (sender), `otel-endpoint.mjs`
(SSRF guard), `otel-worker.mjs` (outbox worker), `secrets.mjs` (encryption),
`db.mjs` (tables and accessors), `server.mjs` (`handleOtelRoute`, the ingest
hook). Tests: `test/otel-*.test.mjs`, `test/secrets.test.mjs`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_SECRETS_KEY` | _(empty)_ | 64 hex characters (32 bytes). Encrypts stored headers. Generate with `openssl rand -hex 32`. |
| `TARGET_SECRETS_KEY_PREVIOUS` | _(empty)_ | Old key during a rotation; decrypt only. |
| `TARGET_SECRETS_DEV_KEY` | `0` | `1` generates `.target-secrets.key` (mode 0600) next to the default database when `TARGET_SECRETS_KEY` is unset. Loopback binds only; ignored with a warning on a public bind. |
| `TARGET_OTEL_ALLOW_PRIVATE` | `0` | Only the value `1` allows `http` and localhost/private/link-local endpoints. |
| `TARGET_OTEL_INTERVAL_SECONDS` | `10` | Worker pass interval. `0` disables the timer. |
| `TARGET_OTEL_OUTBOX_MAX_AGE_DAYS` | `7` | Outbox rows older than this are deleted. |

`TARGET_SECRETS_KEY` must **not** be the same value as `TARGET_AUTH_SECRET`
(that one is stored in the control-plane database; the encryption key must not
live next to the data it protects). On Render declare it with `sync: false`
(see `render.yaml`) and set it in the dashboard.

## Permissions

| Permission | Allows |
| --- | --- |
| `telemetry.read` | `GET /api/settings/otel` |
| `telemetry.write` | `PUT`, `DELETE` and `POST /api/settings/otel/test` |

Both are granted to the built-in `admin` role, like `pricing.*`; custom roles
get them only when an admin assigns them. Holding `telemetry.write` lets a
user send the organization's activity to any endpoint the SSRF rules allow, so
grant it deliberately. See [rbac.md](rbac.md). A missing session is `401`, a
missing permission is `403 {"error":"forbidden","permission":"telemetry.write"}`.

## Settings API

Base path `/api/settings/otel`. JSON in and out. Every route acts on the
**current organization** only (its own SQLite file in multi-org mode).

| Route | Permission | Success |
| --- | --- | --- |
| `GET /api/settings/otel` | `telemetry.read` | `200` settings body |
| `PUT /api/settings/otel` | `telemetry.write` | `200` settings body |
| `POST /api/settings/otel/test` | `telemetry.write` | `200 {ok, status, error}` |
| `DELETE /api/settings/otel` | `telemetry.write` | `200 {"ok":true}` |

Any other method on these paths is `405 {"error":"method not allowed"}`.

### Settings body (`GET`, and the reply to `PUT`)

```json
{
  "organization": { "id": "2844df25-0af4-4e46-b161-4dec77c16442", "name": "second-organization" },
  "config": {
    "enabled": true,
    "endpoint": "https://otlp.example.com",
    "headers": [{ "name": "Authorization", "masked": "••••1234" }],
    "signals": ["traces", "metrics"],
    "sendContent": true,
    "langfuseAttrs": false,
    "updatedAt": "2026-10-03T10:00:00.000Z"
  },
  "secretsAvailable": true,
  "allowPrivateEndpoints": false,
  "status": {
    "enabled": true,
    "enabledAt": "2026-10-03T10:00:00.000Z",
    "lastOkAt": "2026-10-03T10:00:10.000Z",
    "lastError": null,
    "outbox": { "pending": 0, "sent": 12, "dead": 0 }
  }
}
```

An organization that never saved settings gets the defaults: `enabled: false`,
`endpoint: ""`, `headers: []`, `signals: ["traces","metrics"]`,
`sendContent: true`, `langfuseAttrs: false`, null timestamps.

`sendContent` is **on by default for an organization that has never saved a
configuration**: GET reports `true`, and the first `PUT` that omits it stores
`true` (an explicit `false` is stored as `false`). A `PUT` to an existing
configuration that omits it keeps the stored value. **Existing configurations
are never changed**: no migration or startup code rewrites `send_content`, so an
organization that saved it off stays off. The default lives in code, not in the
SQLite column default, so no table is rebuilt.

- `organization` is the current organization: its `id` (the value exported as
  `target.org`) and its `name` from the control database (the id when the name
  is empty or cannot be read). It is shown in the UI so the id can be copied.
- `headers` lists **names only** plus `masked`: `••••` and the last 4
  characters of the value (values of 8 characters or fewer show just `••••`).
  A full value is never returned by any route. If a stored header cannot be
  decrypted (key missing or rotated away) it is listed with `masked: "••••"`.
- `secretsAvailable` is `false` when no valid `TARGET_SECRETS_KEY` is set.
- `status.enabledAt` is when the exporter was last switched on.
  `lastOkAt` / `lastError` come from the worker (`lastError` is a short string
  such as `traces: HTTP 401` or `endpoint_private`, never a header value).

### `PUT /api/settings/otel`

All fields are optional except that **`endpoint` is required (non-empty) when
`enabled` is `true`**; an omitted field keeps its stored value.

| Field | Type | Notes |
| --- | --- | --- |
| `enabled` | boolean | Off to on stamps `enabledAt`; staying on keeps it; on again later resets it |
| `endpoint` | string, max 2048, `""` allowed when disabled | Validated against the SSRF rules below |
| `headers` | object `name -> value`, max 20 | The **full** header set. See below. Names: letters, digits and `` !#$%&'*+.^_`|~- `` (max 100). Values: string up to 4096 |
| `signals` | array of `"traces"`, `"metrics"` | 1 or 2 unique entries |
| `sendContent` | boolean | Default **true** for a new configuration. Adds the workflow name and the organization name (`target.org.name`); step descriptions, acceptance criteria, error messages and conversation content are never exported |
| `langfuseAttrs` | boolean | Adds the `langfuse.*` attributes |

`headers` semantics: a name with a value sets (and encrypts) it; a name whose
value is `""` or `null` **keeps the stored secret**; a name that is not listed
is **removed**. Sending `headers` at all replaces the set; leaving it out
changes nothing. Unknown top-level fields are ignored (the same as every other
route).

```http
PUT /api/settings/otel
{"enabled": true, "endpoint": "https://otlp.example.com",
 "headers": {"Authorization": "Bearer ...", "X-Team": ""}}
```

### `POST /api/settings/otel/test`

Sends one span (`target.otel.test`) and one counter data point
(`target.otel.test`) with no workflow data, to the **saved** endpoint with the
saved headers, one attempt each, no redirects, 8 s timeout, for each enabled
signal. Reply `200 {"ok": true|false, "status": <http status or null>,
"error": null | "<signal>: <reason>"}`. A failed delivery is still `200` with
`ok: false`; `error` looks like `traces: HTTP 401` or `metrics: network error:
ECONNREFUSED` and never contains header values. The test does not touch
`lastOkAt` / `lastError` or the outbox.

### `DELETE /api/settings/otel`

Deletes the settings row, the outbox and the export state of the organization.
Idempotent; always `200 {"ok":true}`.

### Error codes

| Status | Body | When |
| --- | --- | --- |
| 401 | _(auth guard)_ | No valid session |
| 403 | `{"error":"forbidden","permission":...}` | Role lacks the permission |
| 405 | `{"error":"method not allowed"}` | Unsupported method |
| 409 | `secrets_unavailable` | `PUT` would enable the exporter, write a new header value, or edit an already enabled exporter while no valid `TARGET_SECRETS_KEY` is set; also `POST .../test` when stored headers cannot be decrypted |
| 409 | `not_configured` | `POST .../test` with no saved endpoint |
| 422 | `{"errors":[{field,code,message}]}` | Payload failed validation |
| 422 | `header_value_required` | A header name without a value that has no stored secret to keep |
| 422 | `endpoint_invalid` | Not an absolute `http(s)` URL |
| 422 | `endpoint_scheme` | `http` without `TARGET_OTEL_ALLOW_PRIVATE=1` |
| 422 | `endpoint_credentials` | URL contains `user:password@` (use a header instead) |
| 422 | `endpoint_private` | Local, private, link-local or metadata address, literal or resolved |
| 422 | `endpoint_unresolvable` | DNS lookup failed or returned nothing |

Errors from the endpoint check and the secrets checks have the shape
`{"error": "<code>", "message": "<text>"}`. Messages never include secret
values.

## Storage

Three tables, created idempotently in **each organization's** SQLite file
(`migrateOtelSchema` in `db.mjs`):

| Table | Purpose |
| --- | --- |
| `otel_exports` | One row (`id = 1`): `enabled`, `endpoint`, `headers_enc`, `signals` (`traces,metrics`), `send_content` (column default 0; the application treats a new configuration as 1, see Settings body), `langfuse_attrs` (0), `enabled_at`, `last_ok_at`, `last_error`, `updated_at` |
| `otel_outbox` | One row per event to export: `event_id` (unique), `kind`, `status` (`pending`, `sent`, `dead`), `attempts`, `next_attempt_at`, `created_at` |
| `otel_export_state` | Per `workflow_id` + `session_id`: last exported cumulative input / output / cache-read / cache-creation tokens and cost (`last_cost_usd`), `updated_at`. This is the base for metric deltas |

`headers_enc` is a JSON object `{ "<header name>": "<envelope>" }`: names are
plain, **each value is encrypted separately**. A raw `SELECT` never shows a
header value.

## How events are exported

1. **Enqueue.** After `/ingest` stores a new event, it is queued only if the
   exporter is enabled for that organization, the batch was received at or
   after `enabled_at`, and the kind is one of `workflow.created`,
   `workflow.status_changed`, `step.started`, `step.done`, `step.failed`,
   `step.judged`, `usage.snapshot`. With the exporter off there is no outbox
   write at all. The enqueue is wrapped in try/catch: a failure is logged and
   the `/ingest` response is unchanged. Ingest never waits for the destination.
2. **Worker.** A timer (every `TARGET_OTEL_INTERVAL_SECONDS`, unref'd, stopped
   when the server closes) visits each active organization. An organization with
   the exporter off costs one single-row read. For an enabled one it:
   - deletes outbox rows older than `TARGET_OTEL_OUTBOX_MAX_AGE_DAYS`;
   - re-validates the endpoint (SSRF check, DNS included) and decrypts headers;
     if either fails it records `lastError` and sends nothing;
   - claims due `pending` rows in batches of 200 (up to 5 batches per pass),
     skips events received before `enabled_at`, and builds the requests with
     `otel.mjs` using the organization's `pricing_rules` and `otel_export_state`;
   - sends traces then metrics, honouring `signals`, `sendContent` and
     `langfuseAttrs`, with one attempt per pass.
3. **Outcome.**
   - Success (2xx): rows become `sent` and the new export state is written **in
     the same transaction**; `last_ok_at` is set and `last_error` cleared. A
     `partialSuccess` reply is logged.
   - Retryable failure (`429`, `502`, `503`, `504`, network error, timeout): rows
     stay `pending`, `attempts` increases and `next_attempt_at` moves out by
     10 s, 20 s, 40 s ... capped at 5 minutes. `last_error` is set.
   - Any other failure (other 4xx, 3xx - redirects are never followed):
     rows become `dead` and `last_error` is set.

Delivery is **at-least-once**. Traces have deterministic ids, so a re-send is
harmless. Metrics are DELTA sums and OTLP has no idempotency key: if the
process stops after the destination accepted a metrics request but before the
commit, the next pass re-sends that batch with the same deltas (the state was
not advanced, so they are never doubled in size) and the destination counts it
twice. The window is small but real. If a traces request succeeds and the
metrics request then fails, the retry re-sends the traces.

`dead` rows are not retried. Their `usage.snapshot` totals are cumulative, so a
later snapshot of the same session still exports the difference since the last
**successful** export.

## Security model

- **Encryption.** AES-256-GCM (`node:crypto` only), a random 12-byte IV per
  value, and the organization id as additional authenticated data, so a
  ciphertext copied into another organization's database does not decrypt.
  Envelope: `v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url), where `keyId` is the
  first 8 hex characters of the SHA-256 of the key.
- **Fail closed.** Without a valid `TARGET_SECRETS_KEY` the exporter cannot be
  enabled, new header values are refused (`secrets_unavailable`) and
  `secretsAvailable` is `false`. An invalid key (wrong length or non-hex) counts as
  missing. The generated dev key file (`TARGET_SECRETS_DEV_KEY=1`) exists only for
  loopback binds.
- **Key rotation.**
  1. Generate a new key: `openssl rand -hex 32`.
  2. Set `TARGET_SECRETS_KEY_PREVIOUS` to the **current** key and
     `TARGET_SECRETS_KEY` to the new one, then restart. Old values still decrypt
     through the previous key (matched by `keyId`); new writes use the new key.
  3. Re-save each organization's headers (`PUT` with the header values, not
     blanks) so they are re-encrypted with the new key.
  4. Remove `TARGET_SECRETS_KEY_PREVIOUS`. A value still under the old key is
     then unreadable: it appears as `masked: "••••"`, is not sent, and `lastError`
     says the stored headers cannot be decrypted. Re-enter it.
  Losing the key has the same effect: re-enter the headers.
- **Masking and logging.** The API returns header names and the last 4
  characters only. Secrets, header values and request bodies are never logged;
  errors carry a status or error name only.
- **Privacy.** Ids, token counts, cost and durations always leave the server.
  `sendContent` (on by default for a new configuration, never changed for an
  existing one) adds exactly two names: the workflow name and the organization
  name (`target.org.name`, on the resource and, for metrics, on every data
  point). Step descriptions or prompts, acceptance criteria, error messages
  (only the error kind is sent) and conversation content are never exported,
  whatever the setting. Unchecking it removes the names from future exports;
  data already exported is not changed.
- **SSRF.** The endpoint must be `https` and must not carry credentials. These
  are rejected, **after DNS resolution too (every returned address is checked)**:
  `localhost` and `*.local` / `*.internal` names; loopback, private (RFC 1918),
  CGNAT, link-local (including the `169.254.169.254` cloud metadata address),
  multicast and reserved IPv4 ranges; and the IPv6 equivalents, including
  IPv4-mapped, NAT64 and 6to4 forms. Odd spellings such as `2130706433` or
  `0x7f.0.0.1` are normalized first. Redirects are never followed. The check
  runs when settings are saved, before a test, and before every worker pass.
  `TARGET_OTEL_ALLOW_PRIVATE=1` lifts the scheme and address checks (for a local
  Langfuse or otel-lgtm); a server operator decision, not an organization one.
  DNS is resolved at check time and again by `fetch`, so a hostile resolver
  could in theory answer differently between the two.

## Pricing caveat

Cost is computed **at export time** from the organization's pricing rules and
sent already priced (`target.cost.usd`, `target.cost.source`). Editing a pricing
rule changes the dashboard for all history, but it does **not** reprice data
that was already exported: each destination keeps the price in force at that
moment. To correct a period, a manual backfill is needed. Adding a rule for
sessions that were unpriced when exported is covered automatically: the next
cumulative snapshot of the session exports the whole difference.

## Dashboard panel

Settings > **Telemetry export** (`ui/src/components/OtelPanel.tsx`) edits the
settings above for the current organization.

- **Where and who.** The Settings tab opens for `pricing.read` or
  `telemetry.read`; the panel shows only with `telemetry.read`. Saving and
  testing need `telemetry.write`; without it the form is read-only and the Save
  and Test buttons are hidden. Both permissions are in the role editor.
- **Form.** Enabled switch, endpoint URL, header rows, Traces / Metrics
  checkboxes, "Add Langfuse attributes" and "Send content (workflow and organization names)"
  (checked by default for a new configuration, with an explanation of what it
  adds and what is never sent). The organization name and id are shown at the
  top with a Copy button for the id. A static notice says that editing a
  price in Pricing does not change data that was already exported.
- **Headers.** A saved header comes back masked and its value field stays empty
  (the mask is only a placeholder). Leave it empty to keep the saved secret, or
  type a new value to replace it. The panel sends `""` for unchanged headers
  and the typed value for changed or new ones; removing a row removes the
  header. No stored value is ever rendered or logged.
- **Presets.** Langfuse, Grafana Cloud and "My own OpenTelemetry Collector" only
  pre-fill the endpoint, header names, signals and the Langfuse flag; nothing is
  sent or saved until Save. Authorization is never pre-filled: build it as
  `Basic ` plus `echo -n 'user:secret' | base64` (Langfuse: public:secret key;
  Grafana Cloud: instance ID:token). A preset is marked "untested" where
  [observability/phase0-findings.md](observability/phase0-findings.md) says NOT
  TESTED or FAIL: Grafana Cloud (both signals) and Langfuse metrics (Langfuse
  accepts but does not store them, so the preset selects Traces only).
- **Test connection.** Calls `POST /api/settings/otel/test` for the **saved**
  settings, so it is disabled while the form has unsaved changes. It shows
  "Testing the connection…", then **Success** with the HTTP status, or
  **Failed** with the status when there is one and the server's error, such as
  `traces: HTTP 401` (check the Authorization header) or `traces: network error:
  ECONNREFUSED` (wrong host or port). It never shows header values and does not
  change "last successful export" or "last error".
- **Status block.** Last successful export (relative and absolute time), last
  error and the outbox counts, from `status` in `GET /api/settings/otel`.
- **States.** Loading, not configured, configured (on / off), read-only, API
  error (with Retry) and `secretsAvailable=false`. In the last one the whole
  form is disabled and the panel says the server administrator must set
  `TARGET_SECRETS_KEY`.
- **API changes.** None; the panel uses the API above as is.

A real-browser check against a local fake receiver is recorded in
[observability/ui-verification.md](observability/ui-verification.md).

## Not included

No history backfill (only new events),
no OTLP/protobuf or gRPC, no logs signal.
