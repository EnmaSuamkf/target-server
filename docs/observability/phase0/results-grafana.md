# Grafana (otel-lgtm) OTLP/HTTP JSON verification

Environment: `grafana/otel-lgtm:latest` started with `docker compose -f lgtm.compose.yml up -d` (Grafana 13.2.2, bundled collector otelcol-contrib 0.161.0). OTLP HTTP on `localhost:4318`, Grafana on `localhost:3000` (admin/admin). Datasource uids discovered with `GET /api/datasources`: `prometheus` (id 1), `tempo` (id 2), `loki` (id 3), `pyroscope` (id 4).
All requests were sent with `node send.mjs <url> <file> [--now]` (Content-Type: application/json). `--now` shifts every `*UnixNano` to the present while preserving offsets; the negative probes were sent without it (timestamps of 1790000000 s, about 12 days old at test time) and were still accepted by Tempo.

## Summary

| # | Probe | Request | HTTP status | Response body | Verdict |
|---|-------|---------|-------------|---------------|---------|
| 1 | Trace JSON (3 spans, parent/child) | POST :4318/v1/traces payloads/trace.json --now | 200 | `{"partialSuccess":{}}` | PASS - stored in Tempo, structure and attributes verified (see below) |
| 2 | Sum metric, **delta** (target.tokens) | POST :4318/v1/metrics payloads/metrics-sum.json --now | 200 | `{"partialSuccess":{}}` | **FAIL (silent drop)** - 200 but nothing reached Prometheus |
| 3 | Histogram metric, **delta** (target.step.duration) | POST :4318/v1/metrics payloads/metrics-histogram.json --now | 200 | `{"partialSuccess":{}}` | **FAIL (silent drop)** - 200 but nothing reached Prometheus |
| 3b | Sum metric, **cumulative** (aggregationTemporality 2) | POST :4318/v1/metrics payloads/metrics-sum-cumulative.json --now | 200 | `{"partialSuccess":{}}` | PASS - stored as `target_tokens_total` |
| 3c | Histogram metric, **cumulative** | POST :4318/v1/metrics payloads/metrics-histogram-cumulative.json --now | 200 | `{"partialSuccess":{}}` | PASS - stored as `target_step_duration_seconds_{bucket,count,sum}` |
| N1 | Enum as string name (`"kind":"SPAN_KIND_INTERNAL"`) | POST :4318/v1/traces payloads/negative-enum.json | 200 | `{"partialSuccess":{}}` | Accepted (lenient). Stored with kind SPAN_KIND_INTERNAL. Do not rely on it: the spec says integers |
| N2 | ids as base64 (traceId `qqqqqqqqqqqqqqqqqqqqAg==`, spanIds base64) | POST :4318/v1/traces payloads/negative-b64.json | **400** | `{"code":3, "message":"ID.UnmarshalJSONIter: length mismatch, error found in #10 byte of ..."}` (full text in raw output) | REJECTED. Hex is required |
| N3 | Timestamps as JSON numbers | POST :4318/v1/traces payloads/negative-num.json | 200 | `{"partialSuccess":{}}` | Accepted (lenient). Stored with correct values. Still send strings: ns epoch exceeds 2^53 and loses precision as a JS number |

**Key finding:** the stock Prometheus in otel-lgtm does NOT store delta-temporality metrics. The collector answers 200 with an empty `partialSuccess`, so the drop is invisible to the sender. Metrics sent to this stack must be **cumulative** (`aggregationTemporality: 2`). If target-server wants to emit deltas, it must either convert to cumulative itself or send through a Collector with the `deltatocumulative` processor (not tested here).

## Raw send output

### Trace and delta metrics (`send.txt`)
```
== trace
HTTP 200 OK
{"partialSuccess":{}}
== metrics-sum
HTTP 200 OK
{"partialSuccess":{}}
== metrics-histogram
HTTP 200 OK
{"partialSuccess":{}}
```

### Cumulative metrics (`send-cum.txt`)
```
== sum cumulative
HTTP 200 OK
{"partialSuccess":{}}
== histogram cumulative
HTTP 200 OK
{"partialSuccess":{}}
```

### Negative probes (`send-neg.txt`; N3 was re-sent with the full-precision number, see the second block)
```
== negative-enum
HTTP 200 OK
{"partialSuccess":{}}
== negative-b64
HTTP 400 Bad Request
{"code":3, "message":"ID.UnmarshalJSONIter: length mismatch, error found in #10 byte of ...|qqqqqAg==\",\n\t\t\t\t\t\t\t\"|..., bigger context ...|\t\t\t\t{\n\t\t\t\t\t\t\t\"traceId\": \"qqqqqqqqqqqqqqqqqqqqAg==\",\n\t\t\t\t\t\t\t\"spanId\": \"7uGbfsPBsXQ=\",\n\t\t\t\t\t\t\t\"name\": |..."}
== negative-num
HTTP 200 OK
{"partialSuccess":{}}
```
```
$ node send.mjs http://localhost:4318/v1/traces payloads/negative-num.json
HTTP 200 OK
{"partialSuccess":{}}
```
N3 note: the first negative-num send used timestamps truncated to 16 digits (values like 1790000000000000, which is year 2026 in microseconds read as nanoseconds); it was also accepted with HTTP 200 and stored as-is, so the second send (full ns values) was added. Both are visible in the Tempo lookup of trace `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03` below.

## Tempo trace lookup (trace 1)

Command: `curl -s -u admin:admin http://localhost:3000/api/datasources/proxy/uid/tempo/api/traces/5b8efff798038103d269b633813fc60c` (HTTP 200). Tempo returns ids as base64 in its OWN output; the table below decodes them back to hex.

Resource attributes returned: `target.org=demo-org`, `service.name=target-server`.

```
spanId parent name kind status attributes
eee19b7ec3c1b174 parent=- invoke_workflow demo SPAN_KIND_INTERNAL {"code":"STATUS_CODE_OK"} attrs=gen_ai.operation.name=invoke_workflow;gen_ai.provider.name=anthropic;gen_ai.conversation.id=session-demo-1;langfuse.user.id=alice@example.com;langfuse.session.id=session-demo-1;langfuse.trace.name=invoke_workflow demo;target.cost.usd=0.0123
eee19b7ec3c1b175 parent=eee19b7ec3c1b174 invoke_agent step-1 SPAN_KIND_INTERNAL {"code":"STATUS_CODE_OK"} attrs=gen_ai.operation.name=invoke_agent;gen_ai.provider.name=anthropic;gen_ai.request.model=claude-sonnet-4-5;gen_ai.conversation.id=session-demo-1;gen_ai.usage.input_tokens=1200;gen_ai.usage.output_tokens=340;gen_ai.usage.cache_read.input_tokens=800;gen_ai.usage.cache_write.input_tokens=100;langfuse.observation.type=generation;langfuse.observation.model.name=claude-sonnet-4-5;langfuse.observation.usage_details={"input":1200,"output":340,"cache_read_input_tokens":800,"cache_creation_input_tokens":100};langfuse.observation.cost_details={"total":0.0123};target.cost.usd=0.0123
eee19b7ec3c1b176 parent=eee19b7ec3c1b174 execute_tool Bash SPAN_KIND_INTERNAL {"message":"tool exited with code 1","code":"STATUS_CODE_ERROR"} attrs=gen_ai.operation.name=execute_tool;gen_ai.tool.name=Bash;gen_ai.conversation.id=session-demo-1;gen_ai.usage.input_tokens=0;target.cost.usd=0
```

Parent/child structure confirmed: `...b175` (invoke_agent) and `...b176` (execute_tool) both have parent `...b174` (invoke_workflow, root). The ERROR status and its message survived on the third span. Integer attributes (`intValue` strings) and the double `target.cost.usd` came back intact, as did the `langfuse.*` attributes (kept as plain attributes by Tempo).

## Prometheus (via Grafana datasource proxy)

Command: `curl -s -u admin:admin http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/label/__name__/values`, filtered on `target`.

After the DELTA sends (before the cumulative ones): the only match was `target_info`, which belongs to the collector itself (`job=otelcol-contrib`), not to our data. Queries `target_tokens_total`, `target_step_duration_seconds_count|sum|bucket` all returned `"result":[]`:

```
target_info
-- target_tokens_total
{"status":"success","data":{"resultType":"vector","result":[]}}
-- target_step_duration_seconds_count
{"status":"success","data":{"resultType":"vector","result":[]}}
-- target_step_duration_seconds_sum
{"status":"success","data":{"resultType":"vector","result":[]}}
-- target_step_duration_seconds_bucket
{"status":"success","data":{"resultType":"vector","result":[]}}
```

After the CUMULATIVE sends:

```
target_info
target_step_duration_seconds_bucket
target_step_duration_seconds_count
target_step_duration_seconds_sum
target_tokens_total
```

Instant query results:

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

Real stored names and label mapping:

| OTLP | Prometheus |
|------|------------|
| `target.tokens` (sum, unit `{token}`, monotonic) | `target_tokens_total` (dots to underscores, `_total` added; unit `{token}` is NOT appended) |
| attribute `token.type` | label `token_type` |
| `target.step.duration` (histogram, unit `s`) | `target_step_duration_seconds_bucket`, `_count`, `_sum` (unit appended as `_seconds`) |
| attribute `step.status` | label `step_status` |
| resource `service.name` | labels `service_name` and `job` |
| resource `target.org` | NOT a label on the metric series; it appears only as label `target_org` on the `target_info{job="target-server"}` series (confirmed via `/api/v1/query?query=target_info`). Copy it to a datapoint attribute if it must be filterable per series |
| histogram bounds [1,5,10,30] | cumulative `le` buckets 1,5,10,30,+Inf with values 0,1,2,3,3 |

## Tempo lookup of the negative probes

```
== aaaa..01
 [http 200] invoke_workflow demo kind=SPAN_KIND_INTERNAL start=1790000000000000000 end=1790000005000000000
invoke_agent step-1 kind=SPAN_KIND_INTERNAL start=1790000000500000000 end=1790000003000000000
execute_tool Bash kind=SPAN_KIND_INTERNAL start=1790000003000000000 end=1790000004500000000
== aaaa..03
 [http 200] invoke_workflow demo kind=SPAN_KIND_INTERNAL start=1790000000000000 end=1790000005000000
invoke_agent step-1 kind=SPAN_KIND_INTERNAL start=1790000000500000 end=1790000003000000
execute_tool Bash kind=SPAN_KIND_INTERNAL start=1790000003000000 end=1790000004500000
invoke_workflow demo kind=SPAN_KIND_INTERNAL start=1790000000000000000 end=1790000005000000000
invoke_agent step-1 kind=SPAN_KIND_INTERNAL start=1790000000500000000 end=1790000003000000000
execute_tool Bash kind=SPAN_KIND_INTERNAL start=1790000003000000000 end=1790000004500000000
== aaaa..02
 [http 404]
```
(`aaaa...01` = string enum, `aaaa...03` = numeric timestamps, `aaaa...02` = base64 ids, never stored: HTTP 404. Note the base64 trace id could not have been looked up by the hex id anyway; the 400 in N2 already proves rejection.)
