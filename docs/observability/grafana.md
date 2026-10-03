# Sending target-server data to Grafana

Two setups: a **self-hosted** stack you can start in one command (traces, metrics and the ready-made dashboard), and **Grafana Cloud**.

Labels, as in [phase0-findings.md](phase0-findings.md): **PASS / FAIL** were measured by us; **NOT TESTED** means no run against that environment; **unverified** means neither the linked official page nor a test of ours confirms it. "(measured)" marks facts that come from our own tests, not from official docs.

| Destination | Signal | Result |
|---|---|---|
| otel-lgtm direct (`localhost:14318`) | traces | **PASS** (measured, [phase0-findings.md](phase0-findings.md) section 1) |
| otel-lgtm direct | metrics, cumulative | **PASS** (measured) |
| otel-lgtm direct | metrics, **delta** (what target-server sends) | **FAIL**: HTTP 200, then silently dropped (measured) |
| Collector with `deltatocumulative` in front of otel-lgtm | traces and delta metrics | **PASS** (measured; the OTEL 4 compose stack and demo run) |
| Grafana Cloud | traces and metrics | **NOT TESTED** (no credentials in the environment) |

## What the dashboard shows

`grafana/target-server-dashboard.json` (uid `target-server-otel`), built on the real Prometheus names listed in [compose/metric-names.md](compose/metric-names.md):

- cost (USD) by org and runner (`target_cost_usd_USD_total`);
- tokens per hour by token type (`target_tokens_total`);
- workflows completed vs failed, and the failure rate (`target_workflow_completed_total`, `target_workflow_failed_total`);
- step duration p50 and p95 (`target_step_duration_seconds_bucket`);
- step retries (`target_step_retries_total`);
- a table of recent workflows from Tempo (root spans named `invoke_workflow`).

Variables: `Organization` (lists the organization name when it was exported, i.e. Send content is on, and the id otherwise; panels always filter by the id), `Runner` and `Rate window` (the range used by `increase()` and `rate()`; raise it when exports are infrequent). Every panel query was run through Grafana's HTTP API against demo data: [grafana/verification.md](grafana/verification.md).

## Self-hosted: the compose stack

[compose/docker-compose.yml](compose/docker-compose.yml) starts `grafana/otel-lgtm` (Grafana, Tempo, Prometheus, Loki and an OpenTelemetry Collector in one container) and an OpenTelemetry Collector in front of it. otel-lgtm is meant for development, demo and testing, **not production**; Grafana recommends Grafana Cloud for production. Source: <https://github.com/grafana/docker-otel-lgtm>.

```
docker compose -f docs/observability/compose/docker-compose.yml up -d
node scripts/otel-demo-data.mjs          # optional sample data
# Grafana: http://localhost:3000, login admin / admin (source: https://github.com/grafana/docker-otel-lgtm)
docker compose -f docs/observability/compose/docker-compose.yml down -v    # tear down, including data
```

Ports (OTLP ports from the otel-lgtm README, <https://github.com/grafana/docker-otel-lgtm>; the OTLP/HTTP default 4318 and the `/v1/traces`, `/v1/metrics` paths come from <https://opentelemetry.io/docs/specs/otlp/>):

| Host port | Goes to | Use |
|---|---|---|
| 3000 | Grafana UI | dashboards, login admin / admin |
| 4318 | the Collector | **the target-server destination** (traces and metrics) |
| 14318 | otel-lgtm's own OTLP/HTTP | traces only; direct delta metrics are dropped |

### Why there is a Collector

target-server exports metrics as **delta** sums and histograms. otel-lgtm accepts them with HTTP 200 and then never stores them (**FAIL**, measured), so a 200 does not prove the data landed. The Collector's `deltatocumulative` processor turns them into cumulative series that Prometheus keeps (**PASS**, measured). Official description of the processor: <https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/deltatocumulativeprocessor/README.md>. From the same page, relevant to production use:

- it keeps the running totals **in memory**, so a Collector restart loses the state;
- **out-of-order and overlapping samples are discarded** (we hit this while building the demo: see [grafana/verification.md](grafana/verification.md)); target-server's outbox worker sends consecutive, non-overlapping batches, which is what the processor needs;
- `max_stale` (default 5 minutes) removes series that stop receiving samples; the component is marked alpha for metrics.

The Collector config is [compose/otel-collector-config.yaml](compose/otel-collector-config.yaml): an OTLP/HTTP receiver on 4318, `deltatocumulative` and `batch` processors, and an `otlphttp` exporter to `http://lgtm:4318`. (The current contrib image prints a deprecation warning for the names `otlphttp` and `deltatocumulative`; the config still validates and runs on contrib 0.161.0, measured.)

### Fill in the dashboard form

In the dashboard, Settings, Telemetry export, press the **My own OpenTelemetry Collector** preset and set:

- Endpoint URL: `http://localhost:4318`
- Headers: none
- Signals: Traces and Metrics
- **Add Langfuse attributes**: off

A plain `http` or `localhost` endpoint is refused unless the server operator set `TARGET_OTEL_ALLOW_PRIVATE=1` ([../otel-export.md](../otel-export.md)). Press Save, then Test connection. Only events received after you enable the export are sent.

### How the dashboard gets loaded

The compose file mounts two files into the otel-lgtm container (provisioning directory path from <https://github.com/grafana/docker-otel-lgtm>, which names `/otel-lgtm/grafana/conf/provisioning/dashboards/` for custom dashboards):

- `grafana/provisioning/dashboards/target-server.yaml`, a dashboard provider (`type: file`, `options.path`). Provider keys are described at <https://grafana.com/docs/grafana/latest/administration/provisioning/>;
- the dashboard JSON, in `/otel-lgtm/target-server-dashboards/`.

No datasource file is needed: the image already provisions Prometheus with uid `prometheus` and Tempo with uid `tempo`, and the dashboard refers to those uids (checked inside the container, see [grafana/verification.md](grafana/verification.md)).

### Use the dashboard on your own Grafana

Either import it by hand or provision it:

1. **Import**: Dashboards, New, Import dashboard, then upload the JSON file or paste its text (<https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/import-dashboards/>).
2. **Provision**: copy `grafana/provisioning/dashboards/target-server.yaml` into your Grafana's `provisioning/dashboards` directory, point `options.path` at the folder with the JSON, and restart or wait for the provider's update interval (`updateIntervalSeconds`), as described at <https://grafana.com/docs/grafana/latest/administration/provisioning/>.

The JSON refers to datasources by **uid**: Prometheus `prometheus` and Tempo `tempo`. If yours have other uids, replace them in the JSON (for example `sed -i 's/"uid": "prometheus"/"uid": "<your-prometheus-uid>"/'`, and the same for Tempo) or create datasources with these uids (the `uid` field is part of datasource provisioning, <https://grafana.com/docs/grafana/latest/administration/provisioning/>). Metric names must also match: see [compose/metric-names.md](compose/metric-names.md). They were observed with the otel-lgtm Prometheus; other storage layers may name them differently.

## Grafana Cloud (NOT TESTED)

We had no Grafana Cloud credentials, so **nothing in this section was run**. Everything below is from the official docs and is labeled where the docs are silent.

**Endpoint.** `https://otlp-gateway-<REGION>.grafana.net/otlp`; for the real host use the OTLP endpoint on your stack's OpenTelemetry tile, because "your host may differ depending on when your region was created". Signal paths are `/v1/traces`, `/v1/metrics` (and `/v1/logs`), appended to the base URL when you set the base endpoint. Source: <https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/>. In the dashboard form, enter the base URL (`.../otlp`); target-server appends `/v1/traces` and `/v1/metrics`.

**Authentication.** HTTP Basic: username is the **OTLP instance ID** shown on the OpenTelemetry card, password is a Cloud Access Policy token (`glc_...`). Build the header value with `printf '%s' '<otlp-instance-id>:<glc_token>' | base64 | tr -d '\n'` and send `Authorization: Basic <that>`. Source: <https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/get-started/grafana-cloud/>. The same page lists the token scopes `metrics:write`, `traces:write` (and `logs:write`) for sending telemetry. The in-app Grafana Cloud preset hint mentions a "MetricsPublisher" scope; that wording is **unverified** and the official page uses the scopes above, so follow the page.

In the dashboard form: press the **Grafana Cloud** preset, replace `<REGION>`, set the `Authorization` header to `Basic <base64(instanceId:token)>`, keep Traces and Metrics, and leave **Add Langfuse attributes** off.

**Encoding.** Grafana Cloud's OTLP endpoint accepts OTLP/HTTP with binary protobuf (uncompressed or gzip) and "also supports ingestion of JSON protocol buffer encoding, ideally only for low-traffic testing cases. Signals should not be sent via JSON in bulk when binary protocol buffer support is available." Source: <https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/>. target-server only sends JSON, so for anything beyond light traffic put a Collector or Grafana Alloy in front, which can re-encode to protobuf (the Collector `otlphttp` exporter defaults to protobuf, measured in [phase0-findings.md](phase0-findings.md) Q6). Whether Grafana Cloud accepts the exact JSON target-server builds is **NOT TESTED**.

**Delta metrics.** target-server sends delta temporality. Whether Grafana Cloud's metrics store (Mimir) accepts delta directly is **unverified**; the page at <https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/> did not state it in the text we read. The safe path is the one measured with otel-lgtm: convert with a `deltatocumulative` processor first (Collector contrib, link above; Grafana's docs also list an Alloy component `otelcol.processor.deltatocumulative`, named in the navigation of <https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/>, its settings were not read).

**Names.** Grafana Cloud converts `.` and `-` in metric and label names to `_`, and puts resource attributes on `target_info` (except `service.name`, `service.namespace`, `service.instance.id`, which become `job` and `instance`). Source: <https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/>. Whether it also adds the `_total` and unit suffixes seen in otel-lgtm (`target_tokens_total`, `target_step_duration_seconds_bucket`) is **unverified**; check the real names in Explore before using the dashboard.

**Dashboard on Grafana Cloud.** Import the JSON as above, then replace the two datasource uids with your stack's Prometheus (metrics) and Tempo (traces) datasources; the uid values of the Cloud datasources are **unverified**, read them from Connections, Data sources. The Tempo traces table needs a Tempo datasource with the traces you exported.

**Collector or Alloy for Grafana Cloud.** The official page lists the upstream OpenTelemetry Collector and Grafana Alloy among supported senders (<https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/>). We did not write or run a config for them, so none is provided here.

## Limits that apply to both

- Nothing is exported for events received before the export was enabled, and editing a price rule never reprices cost that was already exported ([README.md](README.md)).
- Prometheus counters made from delta data cannot show the very first increment of a new series (`increase()` needs two samples), so the first failure for a new org and runner pair is not counted in the failed-workflow panels.
- Demo data must be fresh. Backdated samples are rejected by Prometheus, and Tempo stops returning traces that ended long before ingestion ([grafana/verification.md](grafana/verification.md)).
