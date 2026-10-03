# Observability: exporting target-server data over OpenTelemetry

Each organization can send its workflow activity to an observability backend as **OpenTelemetry traces and metrics**, using OTLP over HTTP with JSON. Nothing is exported until an organization turns it on. This folder holds the guides, a local test stack, a demo data script and a ready-made Grafana dashboard.

Reference pages: settings API, storage and delivery are in [../otel-export.md](../otel-export.md); every span, metric and attribute is defined in [otel-mapping.md](otel-mapping.md); what was measured against each backend is in [phase0-findings.md](phase0-findings.md).

## Guides per destination

| Destination | Guide | Status |
|---|---|---|
| Langfuse (Cloud or self-hosted) | [langfuse.md](langfuse.md) | traces PASS on self-hosted 4.50.0; metrics FAIL (Langfuse stores none); Cloud NOT TESTED |
| Grafana (self-hosted stack or Grafana Cloud) | [grafana.md](grafana.md) | self-hosted PASS through a Collector; direct delta metrics FAIL; Grafana Cloud NOT TESTED |
| Datadog (Collector, Agent or direct intake) | [datadog.md](datadog.md) | NOT TESTED against Datadog; the example Collector config only passed `otelcol-contrib validate` |
| Any other OTLP backend | [../otel-export.md](../otel-export.md) | use the generic form: endpoint plus headers |

PASS, FAIL and NOT TESTED mean what [phase0-findings.md](phase0-findings.md) says: measured by us, or not run. Anything the guides could not confirm from official documentation is labeled "unverified".

## How the data flows

```
 agents / runners                target-server                              destination
 ----------------   events     ------------------------------------      ---------------------
 claude, cursor,  ---------->  /ingest stores the event                    Grafana / Tempo / Prometheus
 copilot,                      |                                           Langfuse
 free-code                     v  (only if export is on, only new events)  Datadog
                               outbox table (per organization)             any OTLP/HTTP backend
                               |                                                  ^
                               v  worker, every 10 s                              |
                               otel.mjs builds OTLP JSON                          |
                               otel-client.mjs  --- POST /v1/traces  ------------>+
                                                --- POST /v1/metrics ----------->+
                                                (optionally through a Collector)
```

- Ingest never waits for the destination. Failed deliveries are retried with backoff; other failures are marked dead ([../otel-export.md](../otel-export.md)).
- Delivery is at-least-once. Trace ids are deterministic, so a re-sent trace replaces itself. Metrics are **delta** sums with no idempotency key, so a crash at the wrong moment can count one batch twice.
- Metrics are delta. Prometheus-based backends drop delta data silently, so put an OpenTelemetry Collector with the `deltatocumulative` processor in front of them ([grafana.md](grafana.md)). Datadog accepts only delta ([datadog.md](datadog.md)).

## Turn it on

1. **Set the encryption key** on the server. Headers (API keys) are stored encrypted with `TARGET_SECRETS_KEY`: 64 hex characters, generated with `openssl rand -hex 32`. Keep it out of the repository and different from `TARGET_AUTH_SECRET`. Without a valid key the export cannot be enabled and header values are refused (`secrets_unavailable`). On Render declare it as a secret (`sync: false`). For a local, loopback-only server `TARGET_SECRETS_DEV_KEY=1` generates a key file instead. See [../otel-export.md](../otel-export.md).
2. **Allow local endpoints if needed.** Plain `http` and localhost or private addresses are refused unless `TARGET_OTEL_ALLOW_PRIVATE=1` is set on the server (this blocks SSRF by default).
3. **Open Settings, Telemetry export** in the dashboard (requires the `telemetry.write` permission to edit, `telemetry.read` to view). Pick a preset or fill in the endpoint, headers and signals, switch **Enabled** on, press **Save**, then **Test connection**.
4. Only events received **after** you enable it are exported.

The form fields for each destination are in the three guides.

## What is exported

- **Traces** (one per workflow, ids derived from the workflow id): a root span `invoke_workflow` (status OK or ERROR; `invoke_workflow <name>` with **Send content** on), one `step <n>` span per finished step (attempt, retry count, status, phase, and only the error *kind* for failures; the judge result as a span event), and one `invoke_agent <runner>` span per agent session with model, token counts and cost.
- **Metrics** (delta): `target.tokens` (by `token.type`: input, output, cache_read, cache_creation), `target.cost.usd`, `target.step.duration` (histogram, seconds), `target.step.retries`, `target.workflow.completed` and `target.workflow.failed`. Metric attributes are only `target.org`, `target.org.name` (only with **Send content** on; it is 1:1 with the id), `target.runner` and `gen_ai.request.model`, never workflow, session, user or step ids.

**Send content** is **on by default** for an organization that has never saved an export configuration; an existing configuration keeps whatever it stored. When on, it adds exactly two things: the workflow name (`target.workflow.name`, and the root span name) and the organization name (`target.org.name`, on the resource of traces and metrics and on every metric data point). The destination's operator can read them. Unchecking it removes them from future exports; data already exported is not changed.

Real Prometheus names of these metrics are in [compose/metric-names.md](compose/metric-names.md).

## What is NOT exported

- Step descriptions or prompts, and acceptance-criteria text.
- Error messages (only the error kind, such as `timeout`, is sent).
- Conversation content and transcripts.
- Workflow names and the organization name, unless **Send content** is on (the default for a new configuration). Nothing else is unlocked by it.
- Anything that happened **before** the export was enabled: there is no history backfill. Turning it off and on again restarts the cut-off.
- Anything older than `TARGET_OTEL_OUTBOX_MAX_AGE_DAYS` (7 days) that was still waiting in the outbox, and batches that ended `dead`.

The full list, with the reasons, is in [otel-mapping.md](otel-mapping.md) section 6.

## Pricing caveat

Cost is calculated from the organization's price rules **at the moment each usage snapshot is exported**. Editing a price rule later reprices the numbers shown in the target-server dashboard, but it does **not** reprice data that was already exported: Grafana, Langfuse or Datadog keep the old price for the old data. A runner without a matching rule exports tokens but no cost; when a rule appears later, the next snapshot of a session exports the whole cost not yet sent ([otel-mapping.md](otel-mapping.md) section 7).

## Key management and rotation

Secrets live only in the encrypted `headers_enc` column; the API shows header names and the last 4 characters. To rotate `TARGET_SECRETS_KEY` ([../otel-export.md](../otel-export.md), "Key rotation"):

1. Generate a new key with `openssl rand -hex 32`.
2. Set `TARGET_SECRETS_KEY_PREVIOUS` to the current key and `TARGET_SECRETS_KEY` to the new one, then restart.
3. Re-save each organization's headers (send the real values, not blanks) so they are re-encrypted.
4. Remove `TARGET_SECRETS_KEY_PREVIOUS`. A value still under the old key becomes unreadable and must be re-entered. Losing the key has the same effect.

## Try it locally

Everything here is for development and demos, not production. The `grafana/otel-lgtm` image is described by its authors as intended for development, demo and testing environments (<https://github.com/grafana/docker-otel-lgtm>).

```
# 1. Start Grafana + Tempo + Prometheus and a Collector (UI on http://localhost:3000, admin / admin)
docker compose -f docs/observability/compose/docker-compose.yml up -d

# 2. Send sample workflows (several orgs, runners and models, failures, retries, costs)
node scripts/otel-demo-data.mjs                 # default endpoint http://localhost:4318

# 3. Open the "Target Server - OTEL export" dashboard in the "Target Server" folder in Grafana

# 4. Optional: check that every dashboard panel query returns data
node docs/observability/grafana/verify-panels.mjs

# 5. Tear everything down, including data
docker compose -f docs/observability/compose/docker-compose.yml down -v
```

To point a real target-server at the stack use the "My own OpenTelemetry Collector" preset with endpoint `http://localhost:4318` (and `TARGET_OTEL_ALLOW_PRIVATE=1`). Details, ports and why the Collector is there: [grafana.md](grafana.md). A local Langfuse is in [compose/langfuse/](compose/langfuse/) ([langfuse.md](langfuse.md)).

Things the demo run taught us (details in [grafana/verification.md](grafana/verification.md)): demo data must be fresh (Prometheus rejects old samples and Tempo stops returning traces that ended long before ingestion), and a counter's very first increment is invisible to `increase()` (the demo script primes the outcome counters with a zero datapoint, sent in time order).

## Files in this folder

| Path | What |
|---|---|
| [otel-mapping.md](otel-mapping.md) | Event to span and metric contract |
| [phase0-findings.md](phase0-findings.md), [phase0/](phase0/) | What was measured per backend |
| [compose/](compose/) | Local stack (otel-lgtm, Collector), optional Langfuse, observed metric names |
| [grafana/](grafana/) | Dashboard JSON, provisioning, panel verification |
| [examples/](examples/) | Example Collector configs for Datadog |
| `../../scripts/otel-demo-data.mjs` | Demo data generator |
