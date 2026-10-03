# Telemetry export panel: UI verification

Visual check of the Settings > Telemetry export panel (`ui/src/components/OtelPanel.tsx`) in a real browser (Chrome driven by `free-browser`, CDP).

## Setup

- Throwaway server on `127.0.0.1:8991` with `TARGET_SERVER_DB` and `TARGET_CONTROL_DB` in `/tmp/otel-ui-check/` (the repo's `*.db` files were not used), `TARGET_SEED_ADMIN_PASSWORD` set, `TARGET_MAIL_TRANSPORT=noop`, `TARGET_OTEL_ALLOW_PRIVATE=1`.
- Configured and test states: `TARGET_SECRETS_KEY` set (random 64 hex characters, not recorded here).
- Fake OTLP receiver on `127.0.0.1:4399` that answers `200 {"partialSuccess":{}}` and logs the requests.
- Signed in as the seeded `admin@admin.com`. Typing into the sign-in form through the CLI did not submit, so the session was created with an in-page `fetch` to `/api/auth/login`; the panel itself was driven with real clicks and `fill`. This is a CLI quirk, not an app issue (the API login returned 200).
- Settings > "Telemetry export" panel text was dumped with `free-browser raw get text "#telemetry-export"`.
- The fake receiver was stopped before the failure check, and the server was restarted **without** `TARGET_SECRETS_KEY` for the last state.

## 1. Empty: no configuration yet

```
Telemetry export
Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is turned on are sent.
Editing a price in Pricing does not change data that was already exported.

Not configured No destination has been saved yet. Pick a preset or fill in the endpoint, then save.

Last successful export
Never
Last error
None
Queue
0 pending · 0 sent · 0 failed
Presets
Langfuse
metrics untested
Grafana Cloud
untested
My own OpenTelemetry Collector

Presets only pre-fill the form below; nothing is sent or saved until you press Save.

Enabled
Endpoint URL

OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.

Headers

Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.

No headers.

Add header
Signals
Traces
Metrics
Add Langfuse attributes

Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.

Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.

Save
Test connection

Test connection sends a sample span and data point to the saved settings: save a destination first.
```

Presets show "metrics untested" (Langfuse) and "untested" (Grafana Cloud), as in `docs/observability/phase0-findings.md`. "Test connection" is disabled until something is saved.

## 2. Configured

Steps: click the "My own OpenTelemetry Collector" preset (endpoint pre-filled with `http://collector.example.com:4318`, nothing sent), change the endpoint to `http://127.0.0.1:4399`, add header `Authorization` with a secret value, switch Enabled on, Save.

```
Telemetry export
Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is turned on are sent.
Editing a price in Pricing does not change data that was already exported.

Export on New events are being exported to the saved endpoint.

Last successful export
Never
Last error
None
Queue
0 pending · 0 sent · 0 failed
Presets
Langfuse
metrics untested
Grafana Cloud
untested
My own OpenTelemetry Collector

Presets only pre-fill the form below; nothing is sent or saved until you press Save.

My own OpenTelemetry Collector. Point it at your Collector's OTLP/HTTP receiver (port 4318). Add headers only if the receiver requires authentication. Plain http and private addresses are accepted only when the server operator has set TARGET_OTEL_ALLOW_PRIVATE=1.
Enabled
Endpoint URL

OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.

Headers

Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.

Remove
Add header
Signals
Traces
Metrics
Add Langfuse attributes

Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.

Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.

Saved.

Save
Test connection
```

Checks: the DOM of the panel does not contain the typed secret; the saved header row shows an empty password field with the placeholder `••••9876 (saved, type to replace)` (the server's mask); "Test connection" became enabled.

## 3. Test connection: success

```
Telemetry export
Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is turned on are sent.
Editing a price in Pricing does not change data that was already exported.

Export on New events are being exported to the saved endpoint.

Last successful export
Never
Last error
None
Queue
0 pending · 0 sent · 0 failed
Presets
Langfuse
metrics untested
Grafana Cloud
untested
My own OpenTelemetry Collector

Presets only pre-fill the form below; nothing is sent or saved until you press Save.

My own OpenTelemetry Collector. Point it at your Collector's OTLP/HTTP receiver (port 4318). Add headers only if the receiver requires authentication. Plain http and private addresses are accepted only when the server operator has set TARGET_OTEL_ALLOW_PRIVATE=1.
Enabled
Endpoint URL

OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.

Headers

Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.

Remove
Add header
Signals
Traces
Metrics
Add Langfuse attributes

Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.

Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.

Saved.

Success
The destination accepted the test data (HTTP 200).

Save
Test connection
```

The fake receiver logged `POST /v1/traces` and `POST /v1/metrics`. The rendered result element was:
`<p class="msg otel-test otel-test--ok" role="status" data-state="test-success"><span class="badge badge--success">Success</span> The destination accepted the test data (HTTP 200).</p>`

## 4. Test connection: failure (receiver stopped)

Rendered result: `Failed` / `traces: network error: ECONNREFUSED` (`data-state="test-failure"`, `role="alert"`). Full dump:

```
Telemetry export
Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is turned on are sent.
Editing a price in Pricing does not change data that was already exported.

Export on New events are being exported to the saved endpoint.

Last successful export
Never
Last error
None
Queue
0 pending · 0 sent · 0 failed
Presets
Langfuse
metrics untested
Grafana Cloud
untested
My own OpenTelemetry Collector

Presets only pre-fill the form below; nothing is sent or saved until you press Save.

My own OpenTelemetry Collector. Point it at your Collector's OTLP/HTTP receiver (port 4318). Add headers only if the receiver requires authentication. Plain http and private addresses are accepted only when the server operator has set TARGET_OTEL_ALLOW_PRIVATE=1.
Enabled
Endpoint URL

OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.

Headers

Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.

Remove
Add header
Signals
Traces
Metrics
Add Langfuse attributes

Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.

Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.

Saved.

Failed
traces: network error: ECONNREFUSED

Save
Test connection
```

## 5. secretsAvailable = false (server restarted without TARGET_SECRETS_KEY)

```
Telemetry export
Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is turned on are sent.
Editing a price in Pricing does not change data that was already exported.

Export on New events are being exported to the saved endpoint.

Storing credentials is not available: the server administrator must set TARGET_SECRETS_KEY (64 hex characters, for example from openssl rand -hex 32) and restart the server. The form is disabled until then.
Last successful export
Never
Last error
stored headers cannot be decrypted with the configured key
Queue
0 pending · 0 sent · 0 failed
Presets
Langfuse
metrics untested
Grafana Cloud
untested
My own OpenTelemetry Collector

Presets only pre-fill the form below; nothing is sent or saved until you press Save.

Enabled
Endpoint URL

OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.

Headers

Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.

Remove
Add header
Signals
Traces
Metrics
Add Langfuse attributes

Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.

Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.

Save
Test connection
```

DOM check: `fieldset.disabled = true`, Save disabled, the snapshot lists the switch, endpoint, header inputs and the Test connection button as `disabled`. The last error shows the server's "stored headers cannot be decrypted with the configured key". No secret in the DOM.

## Cleanup

Throwaway server and fake receiver stopped; files in `/tmp/otel-ui-check/` only. The free-browser Chrome (CDP :9222) was already running before this check, so it was left running and the tab was navigated to `about:blank`.

## Organization name and id, Copy, and Send content (OTEL 5)

Checked on 2026-10-04 in Chrome driven by the free-browser CLI against a throwaway server (port 8977, temporary `TARGET_SERVER_DB` / `TARGET_CONTROL_DB`, `TARGET_SECRETS_DEV_KEY=1`, `TARGET_OTEL_ALLOW_PRIVATE=1`), signed in as the seeded admin, Settings, Telemetry export, on a fresh organization (no saved configuration).

Text of the organization block (`raw get text "#telemetry-export .otel-org"`):

```
Organization
Default
ID
default
Copy

This id is the value that appears as target.org in Grafana, Tempo and Prometheus.
```

After clicking the button named "Copy organization id" (found by its aria-label) the block read `default` / `Copied` / `Copied to clipboard`. Reading the clipboard back with `navigator.clipboard.readText()` timed out in this automation (no permission prompt can be answered), so the copied value itself was not read back; the "Copied" confirmation is shown only after `writeText` resolves.

Checkbox states on the fresh organization (`raw eval` over `#telemetry-export input[type=checkbox]`):

```
Enabled: false
Traces: true
Metrics: true
Add Langfuse attributes: false
Send content (workflow and organization names): true
```

Send content text next to the checkbox:

```
Send content (workflow and organization names)

When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids. Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already exported is not changed.

Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent) and conversation content.
```

Not exercised in the browser: the clipboard-failure message (covered by the source test in `test/otel-ui.test.mjs`) and the Organizations panel (it needs a multi-organization server).
