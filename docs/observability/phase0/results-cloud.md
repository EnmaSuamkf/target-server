# Cloud destinations (Grafana Cloud, Datadog) - OTLP/HTTP JSON

Credential check, run with `[ -n "${VAR}" ]` so values are never printed:

```
GRAFANA_CLOUD_OTLP_ENDPOINT: not set
GRAFANA_CLOUD_OTLP_AUTH: not set
DD_API_KEY: not set
DD_SITE: not set
```

No request was sent to either destination. Nothing below is a measured result.

## Summary

| # | Destination | Signal | Request | HTTP status | Response body | Verdict |
|---|-------------|--------|---------|-------------|---------------|---------|
| 1 | Grafana Cloud | traces | POST `<GRAFANA_CLOUD_OTLP_ENDPOINT>/v1/traces` payloads/trace.json | - | - | NOT TESTED: no credentials in the environment |
| 2 | Grafana Cloud | metrics | POST `<GRAFANA_CLOUD_OTLP_ENDPOINT>/v1/metrics` payloads/metrics-sum-cumulative.json, metrics-histogram-cumulative.json | - | - | NOT TESTED: no credentials in the environment |
| 3 | Datadog (direct OTLP intake) | traces | POST `/v1/traces` on the intake host for `DD_SITE` payloads/trace.json | - | - | NOT TESTED: no credentials in the environment |
| 4 | Datadog (direct OTLP intake) | metrics | POST `/v1/metrics` on the intake host for `DD_SITE` payloads/metrics-*.json | - | - | NOT TESTED: no credentials in the environment |

## Documentation notes (not verified by a request)

- Datadog page read: https://docs.datadoghq.com/opentelemetry/setup/agentless/. It lists the direct OTLP intake paths `/v1/traces` and `/v1/metrics` (and logs), says to use them "when deploying a Collector or Agent is not feasible", and gives payload limits of 15 MiB uncompressed for traces and 512 KiB compressed for metrics. The page content available to this run did NOT state the required header names, the exact intake hostnames, or whether JSON encoding is accepted, so none of that is asserted here. Whether Datadog accepts `application/json` stays **unknown** until someone with a key tests it.
- Grafana Cloud: the endpoint form `https://otlp-gateway-<REGION>.grafana.net/otlp` with Basic auth comes from the task background, not from a request made in this spike.
- Learned elsewhere in this spike and relevant to both: Prometheus-backed Grafana stacks drop delta metrics silently (results-grafana.md), so send cumulative metrics or go through a Collector with `deltatocumulative` (results-collector.md). A Collector with the `otlphttp` exporter is the fallback for any vendor that rejects JSON.

## How to run later

```
export OTLP_HEADERS="Authorization=Basic <base64 instanceId:token>"   # Grafana Cloud
node docs/observability/phase0/send.mjs "$GRAFANA_CLOUD_OTLP_ENDPOINT/v1/traces" docs/observability/phase0/payloads/trace.json --now
```

`send.mjs` never prints header values.
