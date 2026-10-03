# Plain OpenTelemetry Collector verification

Environment: `otel/opentelemetry-collector-contrib:latest` (otelcol-contrib 0.161.0) in front of `grafana/otel-lgtm:latest`, started with `docker compose -f collector.compose.yml up -d` (host port **4319** -> Collector 4318; Grafana on 3000). Config: `collector-config.yaml` (otlp http receiver on 4318, `deltatocumulative` + `batch` processors, `otlphttp/lgtm` exporter to `http://lgtm:4318` with the default protobuf encoding, plus a `debug` exporter). All payloads were sent with `send.mjs ... --now` to the Collector, and verified through the Grafana datasource proxy (admin/admin). Stack removed afterwards with `docker compose down -v`.

## Summary

| # | Probe | Request | HTTP status | Response body | Verdict |
|---|-------|---------|-------------|---------------|---------|
| 1 | Trace JSON | POST :4319/v1/traces payloads/trace.json | 200 | `{"partialSuccess":{}}` | PASS. Same 3 spans with the same parent/child structure found in Tempo through Grafana |
| 2 | Sum metric, **delta** | POST :4319/v1/metrics payloads/metrics-sum.json | 200 | `{"partialSuccess":{}}` | PASS. Unlike direct delivery to otel-lgtm (dropped), the Collector with the `deltatocumulative` processor made it appear as `target_tokens_total` |
| 3 | Histogram metric, **delta** | POST :4319/v1/metrics payloads/metrics-histogram.json | 200 | `{"partialSuccess":{}}` | PASS. Appears as `target_step_duration_seconds_{bucket,count,sum}` |
| 4 | Second delta send of the same sum | POST :4319/v1/metrics payloads/metrics-sum.json | 200 | `{"partialSuccess":{}}` | PASS. Series accumulated (1200 -> 2400, 340 -> 680): the Collector keeps cumulative state |
| N1 | Enum as string name | POST :4319/v1/traces payloads/negative-enum.json | 200 | `{"partialSuccess":{}}` | Accepted (same lenient behaviour as direct otel-lgtm) |
| N2 | ids as base64 | POST :4319/v1/traces payloads/negative-b64.json | **400** | `{"code":3, "message":"ID.UnmarshalJSONIter: length mismatch, error found in #10 byte of ..."}` (full text below) | REJECTED, same as direct. Hex is required |
| N3 | Timestamps as JSON numbers | POST :4319/v1/traces payloads/negative-num.json | 200 | `{"partialSuccess":{}}` | Accepted (lenient) |

Findings:
- A plain Collector accepts the same OTLP/JSON bodies on `/v1/traces` and `/v1/metrics`, with the same strictness as the built-in collector of otel-lgtm (hex ids required; string enums and numeric timestamps tolerated).
- **The Collector fixes the delta-metric problem found in results-grafana.md.** Prometheus drops deltas silently; `deltatocumulative` converts them. Caveat: the cumulative state lives in Collector memory, so a Collector restart resets the counters; and every sender must keep a stable series identity.
- The Collector re-encodes to protobuf for the otlphttp exporter by default, so a backend that only wants protobuf (or Datadog/other vendors) can sit behind it while target-server keeps sending JSON.
- A first run sent delta and cumulative payloads for the same metric names in a row; the mixed result was not interpretable, so the stack was recreated and only the delta payloads were sent for the evidence below. Cumulative passthrough through the Collector was not separately tested (cumulative metrics were verified directly against otel-lgtm in results-grafana.md).

## Raw send output (stack recreated, delta payloads only)

```
== POST :4319/v1/traces payloads/trace.json --now
HTTP 200 OK
{"partialSuccess":{}}
== POST :4319/v1/metrics payloads/metrics-sum.json --now
HTTP 200 OK
{"partialSuccess":{}}
== POST :4319/v1/metrics payloads/metrics-histogram.json --now
HTTP 200 OK
{"partialSuccess":{}}
== POST :4319/v1/traces payloads/negative-enum.json
HTTP 200 OK
{"partialSuccess":{}}
== POST :4319/v1/traces payloads/negative-b64.json
HTTP 400 Bad Request
{"code":3, "message":"ID.UnmarshalJSONIter: length mismatch, error found in #10 byte of ...|qqqqqAg==\",\n\t\t\t\t\t\t\t\"|..., bigger context ...|\t\t\t\t{\n\t\t\t\t\t\t\t\"traceId\": \"qqqqqqqqqqqqqqqqqqqqAg==\",\n\t\t\t\t\t\t\t\"spanId\": \"7uGbfsPBsXQ=\",\n\t\t\t\t\t\t\t\"name\": |..."}
== POST :4319/v1/traces payloads/negative-num.json
HTTP 200 OK
{"partialSuccess":{}}
```

Second delta send:

```
== second delta send (same payload, --now): expect accumulation
HTTP 200 OK
{"partialSuccess":{}}
{"__name__":"target_tokens_total","job":"target-server","service_name":"target-server","token_type":"input"} 2400
{"__name__":"target_tokens_total","job":"target-server","service_name":"target-server","token_type":"output"} 680
```

## Tempo lookup through the Collector (trace 5b8efff798038103d269b633813fc60c, HTTP 200)

Command: `curl -s -u admin:admin http://localhost:3000/api/datasources/proxy/uid/tempo/api/traces/5b8efff798038103d269b633813fc60c` (ids decoded from base64 to hex):

```
eee19b7ec3c1b174 parent=- invoke_workflow demo SPAN_KIND_INTERNAL {"code":"STATUS_CODE_OK"} nattrs=7
eee19b7ec3c1b175 parent=eee19b7ec3c1b174 invoke_agent step-1 SPAN_KIND_INTERNAL {"code":"STATUS_CODE_OK"} nattrs=13
eee19b7ec3c1b176 parent=eee19b7ec3c1b174 execute_tool Bash SPAN_KIND_INTERNAL {"message":"tool exited with code 1","code":"STATUS_CODE_ERROR"} nattrs=5
```

## Prometheus through the Collector

Metric names (`.../api/v1/label/__name__/values` filtered on `target`), before the second delta send:

```
target_info
target_step_duration_seconds_bucket
target_step_duration_seconds_count
target_step_duration_seconds_sum
target_tokens_total
```

Instant queries, after the first delta send:

```
-- target_tokens_total
{"__name__":"target_tokens_total","job":"target-server","service_name":"target-server","token_type":"input"} 1200
{"__name__":"target_tokens_total","job":"target-server","service_name":"target-server","token_type":"output"} 340
-- target_step_duration_seconds_count
{"__name__":"target_step_duration_seconds_count","job":"target-server","service_name":"target-server","step_status":"done"} 3
-- target_step_duration_seconds_sum
{"__name__":"target_step_duration_seconds_sum","job":"target-server","service_name":"target-server","step_status":"done"} 12.5
-- target_step_duration_seconds_bucket
{"__name__":"target_step_duration_seconds_bucket","job":"target-server","le":"1","service_name":"target-server","step_status":"done"} 0
{"__name__":"target_step_duration_seconds_bucket","job":"target-server","le":"5","service_name":"target-server","step_status":"done"} 1
{"__name__":"target_step_duration_seconds_bucket","job":"target-server","le":"10","service_name":"target-server","step_status":"done"} 2
{"__name__":"target_step_duration_seconds_bucket","job":"target-server","le":"30","service_name":"target-server","step_status":"done"} 3
{"__name__":"target_step_duration_seconds_bucket","job":"target-server","le":"+Inf","service_name":"target-server","step_status":"done"} 3
```

After the second delta send (same series accumulated; shown in the block above under "Second delta send").

## Collector log (debug exporter, tail)

```
2026-10-03T16:25:37.238Z	info	Traces	{"resource": {"service.name": "otelcol-contrib", "service.version": "0.161.0"}, "otelcol.component.id": "debug", "otelcol.component.kind": "exporter", "otelcol.signal": "traces", "resource spans": 1, "spans": 3}
2026-10-03T16:25:37.438Z	info	Metrics	{"resource": {"service.name": "otelcol-contrib", "service.version": "0.161.0"}, "otelcol.component.id": "debug", "otelcol.component.kind": "exporter", "otelcol.signal": "metrics", "resource metrics": 2, "metrics": 2, "data points": 3}
2026-10-03T16:25:37.639Z	info	Traces	{"resource": {"service.name": "otelcol-contrib", "service.version": "0.161.0"}, "otelcol.component.id": "debug", "otelcol.component.kind": "exporter", "otelcol.signal": "traces", "resource spans": 1, "spans": 3}
2026-10-03T16:25:37.840Z	info	Traces	{"resource": {"service.name": "otelcol-contrib", "service.version": "0.161.0"}, "otelcol.component.id": "debug", "otelcol.component.kind": "exporter", "otelcol.signal": "traces", "resource spans": 1, "spans": 3}
```
