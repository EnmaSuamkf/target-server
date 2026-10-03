# Sending target-server data to Datadog

**Datadog is NOT TESTED.** We had no Datadog API key (see [phase0/results-cloud.md](phase0/results-cloud.md)), so no request of ours has reached Datadog. Everything below comes from Datadog's official documentation, with the page next to each claim. The one thing we did run is a **config validation**: the Collector example below passes `otelcol-contrib validate` on `otel/opentelemetry-collector-contrib` 0.161.0 (see the end of this page).

Labels: **NOT TESTED** = not run against Datadog; **unverified** = the linked official page does not state it and we did not measure it.

## Which path to use

Datadog's own order of preference ([Send OpenTelemetry data to Datadog](https://docs.datadoghq.com/opentelemetry/setup/)):

| Path | Datadog says it is for | Official page |
|---|---|---|
| **DDOT Collector** (Datadog Distribution of OpenTelemetry) | Recommended solution; a Collector distribution Datadog maintains and supports | <https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/install.md> |
| **Upstream OpenTelemetry Collector** | Users who manage their own Collector or need advanced processing such as tail-based sampling. "This is the recommended setup for a Collector you manage yourself." | <https://docs.datadoghq.com/opentelemetry/setup/collector_exporter.md> |
| **OTLP ingest in the Datadog Agent** | Users on platforms other than Kubernetes Linux, or who want minimal configuration without managing Collector pipelines | <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent.md> |
| **Direct OTLP intake** (agentless) | When deploying a Collector or Agent is not feasible (serverless functions, managed platforms, tight resource limits) | <https://docs.datadoghq.com/opentelemetry/setup/agentless.md> |

**Recommendation: use a Collector or the Agent in production.** Datadog says the same: "For production workloads, Datadog recommends sending OpenTelemetry data through a Datadog Agent or OpenTelemetry Collector. These components provide metadata enrichment, signal processing, and centralized sampling." Source: <https://docs.datadoghq.com/opentelemetry/setup/agentless.md>. Direct intake is the least tested route here (NOT TESTED) and the one with the strictest limits, so use it for trials only.

## Facts that shape the setup

- **Temporality.** Datadog's OTLP **metrics intake accepts only delta metrics**; cumulative ones produce an error (<https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md>). target-server exports **delta** ([otel-mapping.md](otel-mapping.md) section 2), so its metrics match and **no `cumulativetodelta` processor is needed**. This is the opposite of the Grafana/Prometheus case, where deltas are dropped. For delta sums Datadog stores counts, and delta histograms are ingested natively with their buckets; histograms with a count of 0 are dropped (<https://docs.datadoghq.com/metrics/open_telemetry/otlp_metric_types.md>).
- **Encoding.** The direct traces endpoint "supports `http/protobuf` and `http/json` encoding. `grpc` is not supported." (<https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/traces.md>). For metrics, "the exporter supports both HTTP Protobuf and HTTP JSON. HTTP Protobuf is recommended for better performance." (<https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md>). target-server sends JSON, so direct intake is documented as possible, but **NOT TESTED**; the Collector can re-encode to protobuf if JSON misbehaves.
- **Payload limits** (each over the limit gets HTTP 413): metrics 512 KiB compressed on `/v1/metrics`, logs 5.1 MiB uncompressed on `/v1/logs`, traces 15 MiB uncompressed on `/v1/traces` (<https://docs.datadoghq.com/opentelemetry/setup/agentless.md>). target-server's outbox sends up to 200 events per batch ([../otel-export.md](../otel-export.md)); whether that always fits is **unverified**, and a 413 is not retried by target-server (other 4xx make the batch `dead`, same file). A Collector with the `batch` processor sized to these limits avoids the question.
- **Sites.** Datadog sites such as `datadoghq.com` and `datadoghq.eu` are named on <https://docs.datadoghq.com/opentelemetry/setup/collector_exporter.md>; the Collector page says this setup is not supported on `app.ddog-gov.com` and `us2.ddog-gov.com`.

## Path 1: upstream Collector (recommended for a Collector you run)

Datadog's current recommended Collector setup exports over OTLP HTTP to `https://otlp.<DD_SITE>` with a `dd-api-key` header, and needs OpenTelemetry Collector Contrib **v0.154.0 or later** (<https://docs.datadoghq.com/opentelemetry/setup/collector_exporter.md>). The file below is that configuration trimmed to what target-server needs (the full Datadog page also adds host metrics, logs and a `span_metrics` connector for APM, which target-server data does not use). It is saved as [examples/datadog-otlp-http.collector.yaml](examples/datadog-otlp-http.collector.yaml):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  otlp_http:
    endpoint: https://otlp.${env:DD_SITE}
    headers:
      dd-api-key: ${env:DD_API_KEY}
    compression: zstd
    compression_params:
      level: 3
    sending_queue:
      batch:
        sizer: bytes
        min_size: 2097152
        max_size: 4194304

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp_http]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp_http]
```

Where each key comes from (all <https://docs.datadoghq.com/opentelemetry/setup/collector_exporter.md>): the receiver ports 4317/4318 and the `otlp_http` exporter with `endpoint: https://otlp.${env:DD_SITE}`, the `dd-api-key` header, `compression: zstd` with `compression_params.level: 3` ("must be set explicitly for zstd"), and `sending_queue.batch` with `sizer: bytes`, `min_size` 2 MiB and `max_size` 4 MiB ("start flushing batches at 2MiB, split large batches at 4MiB", to avoid 413 responses). The environment variables are `DD_API_KEY` and `DD_SITE`. A `dd-otel-metric-config` header (resource attributes as tags) that the Datadog page adds for metrics is described at <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md>; target-server puts `target.org` on every data point as well as on the resource, so it is not needed to filter by org.

Run it (command from the same page):

```
DD_SITE=datadoghq.com DD_API_KEY=<your key> otelcol-contrib --config datadog-otlp-http.collector.yaml
```

Never write the real API key into the file; pass it by environment variable as above.

**Dashboard form.** Press the **My own OpenTelemetry Collector** preset: Endpoint URL `http://<collector-host>:4318`, no headers (the Collector holds the key), Signals Traces and Metrics, Add Langfuse attributes off. A plain `http` or private-address endpoint needs `TARGET_OTEL_ALLOW_PRIVATE=1` on the target-server process ([../otel-export.md](../otel-export.md)).

### Alternative: the Datadog exporter

Datadog still documents the classic `datadog` exporter and `datadog` connector, but now recommends the setup above for new configurations (<https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/datadog_exporter.md>). A trimmed version is saved as [examples/datadog-exporter.collector.yaml](examples/datadog-exporter.collector.yaml) (keys `exporters.datadog/exporter.api.site`, `api.key`, and `connectors.datadog/connector`, from that page). Both example files pass `otelcol-contrib validate`; neither was run against Datadog.

## Path 2: DDOT Collector

The DDOT Collector ships inside the Datadog Agent and is installed as a Kubernetes DaemonSet with Helm or the Datadog Operator (<https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/install.md>). Its receiver listens on 4317 (gRPC) and 4318 (HTTP) (same page). How to point target-server's JSON at it and which Agent version supports delta metrics there is **unverified**; we did not read past the install page.

## Path 3: OTLP ingest in the Datadog Agent

Enable the receiver in `datadog.yaml` (keys from <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent.md>):

```yaml
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

The same keys for gRPC use port 4317. The environment variable form is `DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT`. Agents since 6.32.0 / 7.32.0 ingest OTLP traces and metrics over gRPC or HTTP (same page). In the dashboard form use the Collector preset with endpoint `http://<agent-host>:4318` and no headers. Whether the Agent's HTTP receiver accepts JSON, and how it treats delta metrics, are **unverified**: that page does not say. Datadog's metric-type page describes delta sums as counts in general (<https://docs.datadoghq.com/metrics/open_telemetry/otlp_metric_types.md>).

## Path 4: direct OTLP intake (NOT TESTED)

For trials, or when no Collector or Agent is possible:

| Item | Value | Source |
|---|---|---|
| Base URL | `https://otlp.<DD_SITE>`, for example `https://otlp.datadoghq.com` | metrics example `https://otlp.datadoghq.com/v1/metrics` in <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md>; `https://otlp.${env:DD_SITE}` in <https://docs.datadoghq.com/opentelemetry/setup/collector_exporter.md>. That the traces endpoint uses the same host is inferred from the Collector page, which sends all signals to it; the traces page itself shows the endpoint per site, **unverified** here |
| Paths | `/v1/traces`, `/v1/metrics` (target-server appends them) | <https://docs.datadoghq.com/opentelemetry/setup/agentless.md> |
| Auth header | `dd-api-key: <your API key>` | <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md>, <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/traces.md> |
| Optional traces headers | `compute_stats: true` (trace metrics are not computed by default for direct traces), `dd-otel-span-mapping` | <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/traces.md> |
| Optional metrics header | `dd-otel-metric-config` (JSON, e.g. `{"resource_attributes_as_tags": true}`) | <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md> |
| Temporality | delta only (matches target-server) | <https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics.md> |

**Dashboard form.** There is no Datadog preset, so use the generic form: Endpoint URL `https://otlp.<DD_SITE>`, one header `dd-api-key` with your key (stored encrypted, only the last 4 characters are shown later), Signals Traces and Metrics, Add Langfuse attributes off. Add `compute_stats` = `true` only if you want trace metrics. Save and use **Test connection**; since this path is NOT TESTED, treat a failure there as information about Datadog's intake (a 4xx body is the place to look), not as a bug in the form. If Datadog rejects the JSON, switch to path 1.

## Validation done for this page

```
docker run --rm -e DD_SITE=datadoghq.com -e DD_API_KEY=dummy \
  -v "$PWD/docs/observability/examples/datadog-otlp-http.collector.yaml:/c.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest validate --config=/c.yaml
```

Both example files exit 0 on contrib 0.161.0 (a deliberately broken config exits 1, so the check is real) and parse as YAML. That proves the component names and keys exist in that build, not that Datadog accepts the data.
