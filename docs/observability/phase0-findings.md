# OTEL Phase 0 findings: OTLP/HTTP JSON against Grafana, Langfuse and a Collector

Spike date: 2026-10-03. Starting commit: `0eedb6384b5de8a683729f18fb9bd15e2199708c` (branch `main`, nothing committed). All evidence, raw outputs and scripts are in `docs/observability/phase0/`. OTEL 1 should be implemented from this file.

Evidence files:
- [results-grafana.md](phase0/results-grafana.md): grafana/otel-lgtm 13.2.2 (bundled otelcol-contrib 0.161.0), direct to port 4318
- [results-langfuse.md](phase0/results-langfuse.md): Langfuse 4.50.0 self-hosted via the official compose
- [results-collector.md](phase0/results-collector.md): otel/opentelemetry-collector-contrib 0.161.0 in front of otel-lgtm
- [results-cloud.md](phase0/results-cloud.md): Grafana Cloud and Datadog

## 1. Summary

| Destination | Signal | Protocol | Verdict | HTTP status | Evidence |
|-------------|--------|----------|---------|-------------|----------|
| otel-lgtm (direct, :4318) | traces | JSON | PASS | 200 `{"partialSuccess":{}}` | [results-grafana.md](phase0/results-grafana.md) |
| otel-lgtm (direct) | metrics, **cumulative** sum + histogram | JSON | PASS | 200 `{"partialSuccess":{}}` | [results-grafana.md](phase0/results-grafana.md) |
| otel-lgtm (direct) | metrics, **delta** sum + histogram | JSON | **FAIL (silent drop)**: accepted, never stored | 200 `{"partialSuccess":{}}` | [results-grafana.md](phase0/results-grafana.md) |
| Langfuse (:3000/api/public/otel) | traces | JSON | PASS (user, session, hierarchy; model/usage/cost only on `chat` spans, see quirk Q4) | 200 (ingestion-job JSON body) | [results-langfuse.md](phase0/results-langfuse.md) |
| Langfuse | metrics | JSON | FAIL (accepted, nothing stored; Langfuse has no metrics) | 200 `{"message":"OK"}` | [results-langfuse.md](phase0/results-langfuse.md) |
| Collector -> otel-lgtm | traces | JSON | PASS | 200 `{"partialSuccess":{}}` | [results-collector.md](phase0/results-collector.md) |
| Collector -> otel-lgtm | metrics, **delta** sum + histogram (with `deltatocumulative`) | JSON | PASS | 200 `{"partialSuccess":{}}` | [results-collector.md](phase0/results-collector.md) |
| Grafana Cloud | traces | JSON | NOT TESTED (no credentials in the environment) | - | [results-cloud.md](phase0/results-cloud.md) |
| Grafana Cloud | metrics | JSON | NOT TESTED (no credentials in the environment) | - | [results-cloud.md](phase0/results-cloud.md) |
| Datadog direct intake | traces | JSON | NOT TESTED (no credentials in the environment) | - | [results-cloud.md](phase0/results-cloud.md) |
| Datadog direct intake | metrics | JSON | NOT TESTED (no credentials in the environment) | - | [results-cloud.md](phase0/results-cloud.md) |

Negative probes (traceId/spanId as base64, enums as names, timestamps as numbers) were run against otel-lgtm and the Collector with identical results; see section 3 and [results-grafana.md](phase0/results-grafana.md) / [results-collector.md](phase0/results-collector.md).

## 2. Payloads that worked

Send with `Content-Type: application/json` to `<base>/v1/traces` or `<base>/v1/metrics`. Timestamps in these files are fixed; real exports must use current time (`send.mjs --now` shifts them).

### 2.1 Trace with parent/child spans (stored in Tempo, parent/child confirmed; sent through otel-lgtm and through the Collector)

```json
{
	"resourceSpans": [
		{
			"resource": {
				"attributes": [
					{ "key": "service.name", "value": { "stringValue": "target-server" } },
					{ "key": "target.org", "value": { "stringValue": "demo-org" } }
				]
			},
			"scopeSpans": [
				{
					"scope": { "name": "target-server.otel", "version": "0.1.0" },
					"spans": [
						{
							"traceId": "5b8efff798038103d269b633813fc60c",
							"spanId": "eee19b7ec3c1b174",
							"name": "invoke_workflow demo",
							"kind": 1,
							"startTimeUnixNano": "1790000000000000000",
							"endTimeUnixNano": "1790000005000000000",
							"attributes": [
								{ "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_workflow" } },
								{ "key": "gen_ai.provider.name", "value": { "stringValue": "anthropic" } },
								{ "key": "gen_ai.conversation.id", "value": { "stringValue": "session-demo-1" } },
								{ "key": "langfuse.user.id", "value": { "stringValue": "alice@example.com" } },
								{ "key": "langfuse.session.id", "value": { "stringValue": "session-demo-1" } },
								{ "key": "langfuse.trace.name", "value": { "stringValue": "invoke_workflow demo" } },
								{ "key": "target.cost.usd", "value": { "doubleValue": 0.0123 } }
							],
							"status": { "code": 1 }
						},
						{
							"traceId": "5b8efff798038103d269b633813fc60c",
							"spanId": "eee19b7ec3c1b175",
							"parentSpanId": "eee19b7ec3c1b174",
							"name": "invoke_agent step-1",
							"kind": 1,
							"startTimeUnixNano": "1790000000500000000",
							"endTimeUnixNano": "1790000003000000000",
							"attributes": [
								{ "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
								{ "key": "gen_ai.provider.name", "value": { "stringValue": "anthropic" } },
								{ "key": "gen_ai.request.model", "value": { "stringValue": "claude-sonnet-4-5" } },
								{ "key": "gen_ai.conversation.id", "value": { "stringValue": "session-demo-1" } },
								{ "key": "gen_ai.usage.input_tokens", "value": { "intValue": "1200" } },
								{ "key": "gen_ai.usage.output_tokens", "value": { "intValue": "340" } },
								{ "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "800" } },
								{ "key": "gen_ai.usage.cache_write.input_tokens", "value": { "intValue": "100" } },
								{ "key": "langfuse.observation.type", "value": { "stringValue": "generation" } },
								{ "key": "langfuse.observation.model.name", "value": { "stringValue": "claude-sonnet-4-5" } },
								{ "key": "langfuse.observation.usage_details", "value": { "stringValue": "{\"input\":1200,\"output\":340,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":100}" } },
								{ "key": "langfuse.observation.cost_details", "value": { "stringValue": "{\"total\":0.0123}" } },
								{ "key": "target.cost.usd", "value": { "doubleValue": 0.0123 } }
							],
							"status": { "code": 1 }
						},
						{
							"traceId": "5b8efff798038103d269b633813fc60c",
							"spanId": "eee19b7ec3c1b176",
							"parentSpanId": "eee19b7ec3c1b174",
							"name": "execute_tool Bash",
							"kind": 1,
							"startTimeUnixNano": "1790000003000000000",
							"endTimeUnixNano": "1790000004500000000",
							"attributes": [
								{ "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
								{ "key": "gen_ai.tool.name", "value": { "stringValue": "Bash" } },
								{ "key": "gen_ai.conversation.id", "value": { "stringValue": "session-demo-1" } },
								{ "key": "gen_ai.usage.input_tokens", "value": { "intValue": "0" } },
								{ "key": "target.cost.usd", "value": { "doubleValue": 0 } }
							],
							"status": { "code": 2, "message": "tool exited with code 1" }
						}
					]
				}
			]
		}
	]
}
```

For Langfuse, the span that carries model, tokens and cost must have `gen_ai.operation.name` = `chat` (or no operation name), NOT `invoke_agent`. This variant of the child span was verified to map model, usage and cost (probe G in [results-langfuse.md](phase0/results-langfuse.md)):

```json
{
	"traceId": "5b8efff798038103d269b633813fc60c",
	"spanId": "eee19b7ec3c1b175",
	"parentSpanId": "eee19b7ec3c1b174",
	"name": "chat claude-sonnet-4-5",
	"kind": 1,
	"startTimeUnixNano": "1790000000500000000",
	"endTimeUnixNano": "1790000003000000000",
	"attributes": [
		{ "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
		{ "key": "gen_ai.provider.name", "value": { "stringValue": "anthropic" } },
		{ "key": "gen_ai.request.model", "value": { "stringValue": "claude-sonnet-4-5" } },
		{ "key": "gen_ai.conversation.id", "value": { "stringValue": "session-demo-1" } },
		{ "key": "gen_ai.usage.input_tokens", "value": { "intValue": "1200" } },
		{ "key": "gen_ai.usage.output_tokens", "value": { "intValue": "340" } },
		{ "key": "langfuse.observation.type", "value": { "stringValue": "generation" } },
		{ "key": "langfuse.observation.model.name", "value": { "stringValue": "claude-sonnet-4-5" } },
		{ "key": "langfuse.observation.usage_details", "value": { "stringValue": "{\"input\":1200,\"output\":340,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":100}" } },
		{ "key": "langfuse.observation.cost_details", "value": { "stringValue": "{\"total\":0.0123}" } }
	],
	"status": { "code": 1 }
}
```

Langfuse also needs, on the root span, `langfuse.user.id`, `langfuse.session.id` and `langfuse.trace.name` (already present in the trace above).

### 2.2 Delta sum metric (works through a Collector with `deltatocumulative`; dropped silently by otel-lgtm directly)

```json
{
	"resourceMetrics": [
		{
			"resource": {
				"attributes": [
					{ "key": "service.name", "value": { "stringValue": "target-server" } },
					{ "key": "target.org", "value": { "stringValue": "demo-org" } }
				]
			},
			"scopeMetrics": [
				{
					"scope": { "name": "target-server.otel", "version": "0.1.0" },
					"metrics": [
						{
							"name": "target.tokens",
							"description": "Tokens consumed by agent steps",
							"unit": "{token}",
							"sum": {
								"aggregationTemporality": 1,
								"isMonotonic": true,
								"dataPoints": [
									{
										"attributes": [{ "key": "token.type", "value": { "stringValue": "input" } }],
										"startTimeUnixNano": "1790000000000000000",
										"timeUnixNano": "1790000060000000000",
										"asInt": "1200"
									},
									{
										"attributes": [{ "key": "token.type", "value": { "stringValue": "output" } }],
										"startTimeUnixNano": "1790000000000000000",
										"timeUnixNano": "1790000060000000000",
										"asInt": "340"
									}
								]
							}
						}
					]
				}
			]
		}
	]
}
```

### 2.3 Delta histogram metric (same condition)

```json
{
	"resourceMetrics": [
		{
			"resource": {
				"attributes": [
					{ "key": "service.name", "value": { "stringValue": "target-server" } },
					{ "key": "target.org", "value": { "stringValue": "demo-org" } }
				]
			},
			"scopeMetrics": [
				{
					"scope": { "name": "target-server.otel", "version": "0.1.0" },
					"metrics": [
						{
							"name": "target.step.duration",
							"description": "Duration of workflow steps",
							"unit": "s",
							"histogram": {
								"aggregationTemporality": 1,
								"dataPoints": [
									{
										"attributes": [{ "key": "step.status", "value": { "stringValue": "done" } }],
										"startTimeUnixNano": "1790000000000000000",
										"timeUnixNano": "1790000060000000000",
										"count": "3",
										"sum": 12.5,
										"min": 2.5,
										"max": 6,
										"bucketCounts": ["0", "1", "1", "1", "0"],
										"explicitBounds": [1, 5, 10, 30]
									}
								]
							}
						}
					]
				}
			]
		}
	]
}
```

For direct delivery to a Prometheus-backed stack, the same files with `"aggregationTemporality": 2` are stored ([metrics-sum-cumulative.json](phase0/payloads/metrics-sum-cumulative.json), [metrics-histogram-cumulative.json](phase0/payloads/metrics-histogram-cumulative.json)).

## 3. Quirks and requirements

Source for each item is in the linked results file.

**Q1. Encoding rules** ([results-grafana.md](phase0/results-grafana.md), [results-collector.md](phase0/results-collector.md)). `traceId` (32 hex) and `spanId`/`parentSpanId` (16 hex) must be hex. Base64 ids are rejected: HTTP **400** `{"code":3, "message":"ID.UnmarshalJSONIter: length mismatch, error found in #10 byte of ..."}`. Enums sent as names (`"kind":"SPAN_KIND_INTERNAL"`) and timestamps sent as JSON numbers were both accepted (200) and stored correctly, but they are outside the spec; always send integer enums and unixNano timestamps **as strings** (a ns epoch exceeds 2^53 and loses precision as a JS number). 64-bit ints (`intValue`, histogram `count`, `bucketCounts`) are strings too. Tempo returns its own output with base64 ids and `SPAN_KIND_*` names; that is output only.

**Q2. partialSuccess and silent drops** ([results-grafana.md](phase0/results-grafana.md)). Every accepted request, including ones whose data was dropped, returns 200 with `{"partialSuccess":{}}` (empty). Delta metrics sent straight to otel-lgtm return exactly that and are never stored. A 200 therefore does not prove storage; the sender cannot detect this.

**Q3. Delta vs cumulative** ([results-grafana.md](phase0/results-grafana.md), [results-collector.md](phase0/results-collector.md)). Prometheus in otel-lgtm stores only cumulative metrics. Fix A: send `aggregationTemporality: 2` (the exporter would then have to keep cumulative state). Fix B: a Collector with the `deltatocumulative` processor, which turned the delta payloads into stored series and accumulated repeated sends (1200 then 2400). Collector state is in memory, so a restart resets counters.

**Q4. Langfuse mapping** ([results-langfuse.md](phase0/results-langfuse.md)).
- Required: `Authorization: Basic base64(pk:sk)` and `x-langfuse-ingestion-version: 4`; endpoint `/api/public/otel/v1/traces`; Langfuse 4.50.0 (needs >= 3.22.0).
- The response is not the OTLP-standard body: 200 with a JSON echo of the queued ingestion job. Ingestion is async (data visible after about 25-30 s).
- Langfuse v4 "events_only" mode: `GET /api/public/traces` and `/api/public/observations` return 404 `{"message":"This endpoint is not available on deployments running in Langfuse v4 events_only mode. ..."}`. Use `GET /api/public/v2/observations?traceId=...&fields=core,basic,model,usage,metadata`.
- **`gen_ai.operation.name=invoke_agent` makes Langfuse ignore model, usage and cost on that span**, even with `langfuse.observation.type=generation` and valid `langfuse.observation.usage_details`/`cost_details`. With `chat` (or no operation name) they map: usage {input, output, cache_*, total} and cost {"total":0.0123}. With only `gen_ai.*` on a `chat` span, Langfuse infers the generation, usage, and computes cost from its own price table (0.0087 in the probe). `gen_ai.usage.cost` was ignored (cost 0).
- `langfuse.user.id` and `langfuse.session.id` map to userId/sessionId on the root observation. Without `langfuse.*`: userId is empty, sessionId is still inferred from `gen_ai.conversation.id`, observation types are inferred (`invoke_agent` -> AGENT, `execute_tool` -> TOOL, root -> SPAN, ERROR status -> level ERROR + statusMessage).
- **Non-langfuse attributes** (`gen_ai.*`, `target.*`, resource attributes, scope) land in the observation `metadata` with keys prefixed `attributes.` and `resourceAttributes.` (and `scope.name`/`scope.version`); they are not filterable fields. `langfuse.*` attributes that are consumed still also appear in metadata.
- Metrics endpoint answers 200 `{"message":"OK"}` but nothing is stored.

**Q5. Prometheus naming** ([results-grafana.md](phase0/results-grafana.md)). Dots become underscores; monotonic sums get `_total`; unit `s` is appended as `_seconds`; unit `{token}` is NOT appended. Histograms become `_bucket`, `_count`, `_sum` with cumulative `le` labels (1,5,10,30,+Inf). So `target.tokens` -> `target_tokens_total`, `target.step.duration` -> `target_step_duration_seconds_{bucket,count,sum}`. Datapoint attributes become labels (`token.type` -> `token_type`, `step.status` -> `step_status`); resource `service.name` -> `service_name` and `job`; resource `target.org` is NOT a label on the series, only on `target_info`. Put anything that must be filterable (org, user) on the datapoint attributes.

**Q6. Collector** ([results-collector.md](phase0/results-collector.md)). A plain contrib Collector accepts the same JSON on `/v1/traces` and `/v1/metrics` with the same strictness as otel-lgtm, and forwards to the next hop with protobuf by default via the `otlphttp` exporter.

**Q7. Cloud** ([results-cloud.md](phase0/results-cloud.md)). Not measured. The Datadog docs page lists `/v1/traces` and `/v1/metrics` direct intake paths and payload limits (15 MiB uncompressed traces, 512 KiB compressed metrics) but, in the fetched content, no header names, hostnames or JSON statement.

## 4. Recommendation per backend and what OTEL 1 must implement

| Backend | Recommendation |
|---------|----------------|
| Langfuse | **Send JSON directly.** Traces only. Per-destination headers `Authorization: Basic ...` and `x-langfuse-ingestion-version: 4`. Do not send metrics. |
| Grafana LGTM / Grafana-style Prometheus backends | **Send JSON directly for traces.** For metrics either emit **cumulative** temporality, or route through a Collector with `deltatocumulative`. Do not emit delta metrics to a Prometheus backend directly (silent loss). |
| Any other OTLP backend (incl. Datadog via a Collector) | **Recommend a Collector** in front. JSON direct is unproven; the Collector can re-encode to protobuf and handle vendor auth. |
| Grafana Cloud, Datadog direct | Unverified; treat as "may need a Collector/protobuf" until tested. |

OTEL 1 must therefore:
1. Build OTLP/JSON by hand with no new runtime dependencies: hex ids, integer enums, camelCase keys, all unixNano and 64-bit integers as strings.
2. Treat any 2xx as success; do not rely on `partialSuccess` content; retry only on 429, 502, 503, 504 honoring `Retry-After`; do not retry other 4xx (e.g. the 400 for bad ids).
3. Make the destination generic: base URL plus free-form headers (stored encrypted), signals enabled per destination (Langfuse: traces only).
4. Emit metrics as **cumulative** by default, or document that deltas require a Collector with `deltatocumulative`.
5. Put model, usage and cost on spans with `gen_ai.operation.name=chat`; keep `invoke_workflow`/`invoke_agent` for structural spans; always add `langfuse.user.id`, `langfuse.session.id`, `langfuse.trace.name`; copy filterable dimensions (e.g. org) to datapoint attributes for metrics.
6. Verify end-to-end with the committed scripts (`phase0/send.mjs`, compose files) rather than trusting the HTTP status.

## 5. Not verified

- Grafana Cloud and Datadog direct OTLP intake with JSON (no credentials). Datadog header names, hostnames and JSON acceptance are unknown.
- `application/x-protobuf` and gRPC (out of scope).
- Cumulative metrics passed through the Collector (only deltas were tested there); `encoding: json` on the Collector `otlphttp` exporter.
- Logs (`/v1/logs`).
- gzip request compression, retry behavior (`429`/`5xx` with `Retry-After`), payload size limits and rate limits of any backend.
- Langfuse behavior for other versions than 4.50.0 (older v3 read API differs), for `langfuse.observation.type` values other than `generation`, and handling of out-of-order or very old timestamps.
- Behavior of the Collector `deltatocumulative` processor across restarts and with multiple senders.
- Whether `target.org` and `target.cost.usd` should be metrics labels or span attributes in practice; Langfuse cost when both explicit `cost_details` and a model price table disagree.
