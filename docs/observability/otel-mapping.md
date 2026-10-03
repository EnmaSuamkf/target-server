# OTEL mapping contract: events to OTLP/HTTP JSON

This is the contract for `otel.mjs` (pure mapping) and `otel-client.mjs` (sender), built in OTEL 1. It follows [phase0-findings.md](phase0-findings.md) wherever that file and the original plan differ; the differences are listed in section 9. No database, config, UI, route or worker is involved: everything here is a pure function of event rows plus a pricing rule table.

Inputs are rows of the `events` table (`id, instance_id, kind, workflow_id, session_id, created_at, received_at, data`). Only these kinds are used; `heartbeat`, `workflow.plan`, `workflow.updated` and everything else are ignored.

## 1. Event to span table

| Event(s) | Span | Kind | Parent | Start | End | Status |
|---|---|---|---|---|---|---|
| `workflow.created` + terminal `workflow.status_changed` (`to` = `completed` or `failed`) | Root `invoke_workflow` (with `sendContent: true`: `invoke_workflow <name>`, `name` from `workflow.created`, `workflow` if absent) | INTERNAL (1) | none | `workflow.created` time, else the first `step.started` time | terminal status event time | OK (1) on `completed`, ERROR (2) on `failed` (no message) |
| `step.done` / `step.failed` (`attempt` taken from the latest preceding `step.started` of the same `step_id`) | Step `step <order_index+1>` | INTERNAL (1) | root | end - `duration_ms` | the `step.done` / `step.failed` event time | OK on done, ERROR on failed (no message) |
| `step.judged` | Span event on the step span, name `step.judged`, attribute `target.step.judge.ok` | n/a | n/a | event time | n/a | n/a |
| `usage.snapshot` (all snapshots of one `(workflow_id, session_id)`) | Session `invoke_agent <runner>` | INTERNAL (1) | root | first snapshot time of the session | last snapshot time of the session | UNSET (0) |

Rules:

- The root span is emitted **only when the terminal status event exists**. Until then nothing is emitted for it; step and session spans may be sent earlier and attach to the root by deterministic id (section 4).
- A step span is emitted only when its `step.done` or `step.failed` exists. `step.started` alone yields no span (a `phase: judge` start is only used to read `phase`/`attempt`).
- `attempt` for a step span comes from the latest preceding `step.started` of the same `step_id` (`step.done`/`step.failed` carry no attempt of their own); when there is none, `attempt` is `0`. If the same `(step_id, attempt)` ends twice in a batch (for example an exec and a judge phase), the later span replaces the earlier one, because the id key is fixed by section 4.
- A `step.judged` with no step span in the same batch is dropped. Its `ok` becomes the span event on the step span with the same `(workflow_id, step_id)` and highest attempt.
- **Tokens and cost attach to the session span and the root span only, never to step spans.** One session spans many steps (57 of 66 real workflows had one session with ~15-24 steps), so a per-step split would be invented. The root span carries the workflow totals as `target.usage.*` and `target.cost.*` attributes (section 3).
- Session `usage.snapshot` rows with `session_id` null are grouped under the key `""` and get the session span id derived from `workflow_id + ":"`.
- Events are ordered by `(received_at, id)`. Out-of-order input is tolerated: all ids are deterministic and no span depends on arrival order.
- Span events are sorted by time. Spans are emitted in the order root, steps (by `order_index`, `attempt`), sessions (by first snapshot time).

## 2. Event to metric table

All metrics use the scope `{ name: "target-server.otel", version: <service.version> }`.

| Metric name | Source event(s) | Instrument | Unit | Value | Monotonic |
|---|---|---|---|---|---|
| `target.tokens` | `usage.snapshot` | Sum | `{token}` | token delta since the previous snapshot of the same session, per `token.type` | true |
| `target.cost.usd` | `usage.snapshot` | Sum | `USD` | cost delta (section 7) | true |
| `target.step.duration` | `step.done`, `step.failed` | Histogram | `s` | `duration_ms / 1000` | n/a |
| `target.step.retries` | `step.done`, and `step.failed` only when terminal (`retry_count` not below `max_retries`, or `max_retries` absent) | Sum | `{retry}` | `retry_count`; a failure that will be retried is skipped because the attempt that ends the step carries the count | true |
| `target.workflow.completed` | `workflow.status_changed` with `to = completed` | Sum | `{workflow}` | 1 per event | true |
| `target.workflow.failed` | `workflow.status_changed` with `to = failed` | Sum | `{workflow}` | 1 per event | true |

- Histogram explicit bounds (seconds): `[1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]`; `bucketCounts` has `bounds.length + 1` entries; `count`, `bucketCounts` are 64-bit strings; `sum`, `min`, `max` are doubles.
- **Temporality** ([phase0 Q3](phase0-findings.md)): OTEL 1 implements **DELTA only** (`aggregationTemporality: 1`), as the workflow brief requires. otel-lgtm accepts delta metrics with `200` and then silently drops them, so a delta destination must be a Collector with the `deltatocumulative` processor. Native cumulative output is not implemented in OTEL 1 and is left for a later step if a direct Prometheus-style destination is needed.
- Langfuse has no metrics endpoint (phase0 Q4). The caller is expected to enable traces only for it; the builder does not know vendors.
- **Allowed attributes, only these three** (plus `target.org.name` when the organization's Send content setting is on; it is 1:1 with `target.org`, so it adds no cardinality, and is also set on the resource): `target.org`, `target.runner`, `gen_ai.request.model`. `gen_ai.request.model` is omitted when the snapshot has no model. `target.tokens` additionally has `token.type` (a dimension of that one metric with four fixed values, not an identifier). Never `workflow_id`, `session_id`, user, step id, or any free text (cardinality). Phase0 Q5: only datapoint attributes become Prometheus labels, which is why `target.org` is repeated on the datapoint and not only on the resource.
- Durations and counters are keyed by (org, runner, model) after aggregation; one datapoint per distinct attribute set and metric. Step and workflow metrics have no model attribute. Zero-valued sums are not emitted.
- Only the **last** `usage.snapshot` of each session in a batch is read and diffed against the caller's state, so intermediate snapshots of a batch add nothing and a replay with the returned state exports no usage. Step and workflow counters are per event: the caller must deliver each event once.
- Every data point of a request uses `startTimeUnixNano` = earliest and `timeUnixNano` = latest event time in the batch.

## 3. Attribute catalogue

Value types use the OTLP `AnyValue` encoding: `stringValue`, `intValue` (**a decimal string**), `doubleValue` (JSON number), `boolValue`.

### 3.1 Resource attributes (traces and metrics)

| Attribute | Type | Value |
|---|---|---|
| `service.name` | string | `"target-server"` |
| `service.version` | string | version passed in (`package.json` version at the call site) |
| `target.org` | string | org id |
| `target.org.name` | string | organization name (id when empty); only when `sendContent` is on |

### 3.2 Root span `invoke_workflow <name>`

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.operation.name` | string | `"invoke_workflow"` |
| `target.workflow.id` | string | workflow id |
| `target.workflow.name` | string | only when `sendContent` is true (names are user text); otherwise omitted and the span name is `invoke_workflow` |
| `target.runner` | string | `workflow.created.data.agent` |
| `target.workflow.status` | string | `completed` or `failed` |
| `target.workflow.step_count` | int | `workflow.created.data.step_count` when present |
| `target.cost.usd` | double | sum of the priced session costs of the workflow |
| `target.cost.partial` | bool | true if any session was unpriced |
| `target.usage.input_tokens`, `target.usage.output_tokens`, `target.usage.cache_read_tokens`, `target.usage.cache_creation_tokens` | int | sums of the **last** snapshot of each session |

### 3.3 Step span `step <n>`

| Attribute | Type | Notes |
|---|---|---|
| `target.workflow.id` | string | |
| `target.step.id` | string | |
| `target.step.index` | int | `order_index` (zero-based; the span name uses `order_index + 1`) |
| `target.step.phase` | string | `exec` or `judge`, from `step.started`/`step.failed` |
| `target.step.attempt` | int | |
| `target.step.retry_count` | int | |
| `target.step.status` | string | `done` or `failed` |
| `target.error.kind` | string | failed steps only: `error.kind`. Nothing else of `error` is read |

Span event `step.judged`: attributes `target.step.judge.ok` (bool). Nothing else.

### 3.4 Session span `invoke_agent <runner>`

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.operation.name` | string | `"invoke_agent"` (but `"chat"` when `langfuse: true`, see section 9) |
| `gen_ai.provider.name` | string | the runner (`claude`, `free-code`, `cursor`, `copilot`); mandatory on agent spans in the GenAI conventions |
| `gen_ai.conversation.id` | string | `session_id` (omitted when null) |
| `gen_ai.request.model` | string | only when present on the last snapshot |
| `gen_ai.usage.input_tokens` | int | `normalizeUsageSnapshot(last).inputTokens` (full input total) |
| `gen_ai.usage.output_tokens` | int | `.outputTokens` |
| `gen_ai.usage.cache_read.input_tokens` | int | `.cacheRead` |
| `gen_ai.usage.cache_write.input_tokens` | int | `.cacheCreation` |
| `target.runner` | string | |
| `target.workflow.id` | string | |
| `target.cost.usd` | double | cumulative cost of the session at its last snapshot; omitted when unpriced |
| `target.cost.partial` | bool | true when unpriced |
| `target.cost.source` | string | `hub`, `pricing` or `unpriced` |

### 3.5 Langfuse attributes (only with `langfuse: true`, one small function)

| Attribute | Span | Type | Value |
|---|---|---|---|
| `langfuse.user.id` | root | string | user passed in (omitted when unknown) |
| `langfuse.session.id` | root | string | workflow id |
| `langfuse.trace.name` | root | string | root span name |
| `langfuse.observation.type` | session | string | `"generation"` |
| `langfuse.observation.usage_details` | session | string (JSON) | `{"input":n,"output":n,"cache_read_input_tokens":n,"cache_creation_input_tokens":n}` |
| `langfuse.observation.cost_details` | session | string (JSON) | `{"total":usd}`, omitted when unpriced |

`langfuse.session.id` and `langfuse.user.id` also go on the session span so they survive a root span that is not yet emitted.

### 3.6 Metric attributes

See section 2: `target.org`, `target.runner`, `gen_ai.request.model`, plus `token.type` on `target.tokens`.

## 4. Deterministic ids

```
traceId = hex( sha256("target:trace:" + workflow_id) )[0 .. 16 bytes]   // 32 hex chars
spanId  = hex( sha256("target:span:"  + key)         )[0 .. 8 bytes]    // 16 hex chars
```

| Span | `key` |
|---|---|
| Root | `workflow_id` |
| Step | `workflow_id + ":" + step_id + ":" + attempt` |
| Session | `workflow_id + ":" + session_id` |

- Hex is lowercase. Base64 ids are rejected by backends with HTTP 400 ([phase0 Q1](phase0-findings.md)).
- Children set `parentSpanId` to the root span id. A root span id is never all zeros; if a hash were all zeros (practically impossible) the last byte is set to `01`.
- Same input always yields the same ids, so a re-send overwrites instead of duplicating, and spans may arrive in any order.

## 5. OTLP JSON encoding and enum integers

Encoding rules: lowerCamelCase keys, hex ids, enums as **integers**, all `*UnixNano` fields and 64-bit integers (`intValue`, `count`, `bucketCounts`, `asInt`) as **decimal strings** (nanosecond epochs exceed 2^53), doubles as JSON numbers. Source: [OTLP specification, JSON Protobuf encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding). Phase0 confirmed ids/strings/integers against otel-lgtm and the Collector ([Q1](phase0-findings.md)); enum names and numeric timestamps are accepted by those receivers but are outside the spec, so they are never sent.

| Enum | Value used | Integer | Source |
|---|---|---|---|
| `Span.SpanKind` `SPAN_KIND_INTERNAL` | all spans | **1** | [trace.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto) (`SPAN_KIND_UNSPECIFIED=0, INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5`) |
| `Status.StatusCode` `STATUS_CODE_UNSET` | session span, in-flight | **0** | [trace.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto) |
| `Status.StatusCode` `STATUS_CODE_OK` | completed workflow, done step | **1** | [trace.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto); used as `"status": {"code": 1}` in the payloads phase0 verified ([phase0-findings.md §2.1](phase0-findings.md)) |
| `Status.StatusCode` `STATUS_CODE_ERROR` | failed workflow or step | **2** | [trace.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto); `"code": 2` in [phase0-findings.md §2.1](phase0-findings.md) |
| `AggregationTemporality` `DELTA` | `temporality: "delta"` | **1** | [metrics.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto) (`UNSPECIFIED=0, DELTA=1, CUMULATIVE=2`); `"aggregationTemporality": 1` in [phase0-findings.md §2.2](phase0-findings.md) |
| `AggregationTemporality` `CUMULATIVE` | `temporality: "cumulative"` (default) | **2** | [metrics.proto](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto); [phase0-findings.md §2.3 last paragraph](phase0-findings.md) |

The step that implements ids and encoding (OTEL 1 step 2) must assert these integers in tests and re-check them against the linked `.proto` files. Status messages are never sent (they would carry error text).

## 6. What is never exported

Never present in any payload, whatever `sendContent` is:

- step descriptions / prompts / titles and any other step text;
- acceptance criteria text (`step.judged.acceptance_criteria` is not read at all);
- error messages (`error.message`, `workflow.status_changed.error`, status messages); only `error.kind` is exported;
- conversation content, `conversation.snapshot` and any transcript data;

Without `sendContent` the payload also has no workflow name (the root span is named `invoke_workflow`) and no `target.org.name`.

`sendContent` (option; the stored organization setting is **on by default** for a configuration that was never saved, while the `buildTraces`/`buildMetrics` option itself defaults to `false`) enables exactly two things: the **workflow name** (root span name and `target.workflow.name`) and the **organization name** `target.org.name` (resource of traces and metrics, and every metric data point; the id when the name is empty). It does **not** unlock step text, acceptance criteria text, error messages or conversation data: those are not exported under any setting. The tests serialize the whole payload (traces and metrics) and assert that sentinel strings planted in those fields are absent with `sendContent` both false and true, and that the workflow and organization names appear only when true.

Also never exported as a metric attribute: workflow id, session id, user, step id.

## 7. Cost-delta algorithm

Reused, not reimplemented:

- `normalizeUsageSnapshot(data)` from `db.mjs` (already exported; handles the old shape where `input_tokens` is uncached and the new shape where it is the full total);
- `priceSession(rules, { agent, at, usage })` from `pricing.mjs` (rule resolution by agent/model/`effectiveFrom`, four token buckets, sources `"hub"` | `"pricing"` | `"unpriced"`);
- `stepCostDeltas(cumulativeCosts)` in `estimates.mjs` defines the clamped-at-zero difference of a cumulative series (a drop means the transcript was compacted, not a refund). `otel.mjs` does not call it (it works on a whole series, the exporter diffs one snapshot against stored state) but applies the same rule: "delta = max(0, cumulative - previous)".

Per `(workflow_id, session_id)`. A snapshot is a **running total**, never summed with another snapshot of the same session. `computeUsageDelta` handles one snapshot; `buildMetrics` feeds it the last snapshot of each session in the batch.

```
prevTokens = state.tokens[session] ?? zeros      // exported so far
prevCost   = state.costUsd         ?? 0          // exported so far
for the snapshot s:
	usage  = normalizeUsageSnapshot(s.data)
	runner = s.data.agent ?? workflow agent ?? null
	priced = priceSession(rules, { agent: runner, at: s.received_at, usage })

	tokenDelta[type] = max(0, usage.type - prevTokens.type)   // input, output, cache_read, cache_creation
	if priced.costUsd is a number:
		costDelta = max(0, priced.costUsd - prevCost)
		nextCost  = priced.costUsd            // also after a decrease: the new total is the new state
	else:
		costDelta = none          // nothing exported, nextCost = prevCost
		partial   = true
	prevTokens = current usage                    // a lower total (compaction) clamps the delta to 0 and becomes the new state
```

- `at` is the snapshot `received_at`, matching how the dashboard prices, so exported cost equals the dashboard number at that moment.
- **Unpriced case** (`source = "unpriced"`, `costUsd = null`): tokens are still exported (spans and `target.tokens`), no `target.cost.usd` datapoint and no `target.cost.usd` span attribute, `target.cost.partial = true`, `target.cost.source = "unpriced"`. `prevCost` stays, so when a rule later exists the next cumulative total covers everything not yet exported.
- Hub cost: when `usage.costUsd` is a number, `priceSession` returns source `hub` and the same delta logic applies to it.
- Token buckets that shrink (compaction) yield 0 delta, not negative values; counters stay monotonic.
- Metrics attributes use the model of the snapshot being processed; the cost of a session is attributed to that snapshot's `(runner, model)`.
- Known limit: editing a pricing rule reprices history in the dashboard but already-exported cost is not corrected (cost is exported at the price of that moment).
- `input` in the token buckets is the **uncached** input (`inputTokensUncached`); the four buckets are disjoint, so they never double count. `input_tokens` on spans stays the full total (`inputTokens`).
- The returned `state` (`{ tokens: {input, output, cache_read, cache_creation}, costUsd }` per `workflow_id:session_id`, plain JSON) is how the caller (OTEL 2 outbox) remembers what was exported. `otel.mjs` never stores it.

## 8. Public API (as implemented)

All ESM, tabs, no new runtime dependencies. Row shape: `{id, instance_id, kind, workflow_id, session_id, created_at, received_at, data}` where `data` may be an object or a JSON string.

### `otel.mjs`

```js
// encoding and ids
export function traceIdFor(workflowId): string                     // 32 hex
export function spanIdFor(key): string                             // 16 hex
export function rootSpanId(workflowId): string
export function stepSpanId(workflowId, stepId, attempt): string
export function sessionSpanId(workflowId, sessionId): string
export function toUnixNano(isoDateOrMs): string | null             // decimal string; null when unparseable
export function anyValue(value): object | null                     // string | integer/bigint -> intValue string | float -> doubleValue | boolean -> boolValue; null/NaN/object -> null
export function attr(key, value): { key, value } | null            // null when the value is skipped
export function attrs(object): Array<{ key, value }>               // skips null/undefined
export function resourceBlock({ org, orgName, serviceVersion }): { attributes }   // service.name, service.version, target.org
export function scopeBlock({ serviceVersion }): { name, version? }       // name "target-server.otel"
export const SERVICE_NAME = "target-server", SCOPE_NAME = "target-server.otel";
export const SPAN_KIND_INTERNAL = 1;
export const STATUS_UNSET = 0, STATUS_OK = 1, STATUS_ERROR = 2;
export const TEMPORALITY_DELTA = 1, TEMPORALITY_CUMULATIVE = 2;

// traces
export function buildTraces({ events, orgId, serviceVersion, runnerByWorkflow = {}, options = {} }): { resourceSpans: [...] } | null
	// options: { rules, sendContent = false, langfuse = false, userId = null, orgName = null }; null when there is nothing to send

// usage, cost, metrics
export function computeUsageDelta({ previousState, snapshot, rules, agent, at }): {
	tokens: { input, output, cache_read, cache_creation },           // input = uncached input
	costDeltaUsd: number | null, costSource: "hub"|"pricing"|"unpriced", partial: boolean, model,
	nextState: { tokens: {...}, costUsd: number },                   // per (workflow, session); plain JSON
}
export function buildMetrics({ events, orgId, serviceVersion, stateBySession = {}, rules = [], runnerByWorkflow = {} }): {
	request: { resourceMetrics: [...] } | null,                      // DELTA temporality, null when nothing to send
	state,                                                           // updated stateBySession, keyed "workflowId:sessionId"
}
export const STEP_DURATION_BOUNDS: number[]

// langfuse (small, isolated)
export function langfuseAttributes(kind /* "root" | "session" */, ctx): Array<{ key, value }>
```

### `otel-client.mjs`

```js
export async function sendOtlp({
	endpoint,                // base URL, or a URL already ending in /v1/traces or /v1/metrics (not double-appended)
	signal,                  // "traces" | "metrics"
	body,                    // request object, or an already serialised JSON string
	headers = {},
	timeoutMs = 10_000,
	gzip = false,            // gzips the body, sets Content-Encoding: gzip
	maxAttempts = 5,
	fetchImpl = globalThis.fetch,   // injectable for tests
	sleep,                          // injectable for tests
	now = Date.now,                 // injectable clock for Retry-After dates
}): Promise<{ ok: boolean, status: number|null, attempts: number, partialSuccess: { rejectedSpans, rejectedDataPoints, errorMessage }|null, error: string|null }>

export function otlpUrl(endpoint, signal): string      // appends /v1/<signal>; keeps an existing /v1/<signal>; swaps another signal's /v1/... path
export function parseRetryAfter(value, nowMs = Date.now()): number|null     // ms, capped at 60 s; seconds or HTTP date
```

Client behavior: `POST` with `Content-Type: application/json`; caller headers merged (the caller cannot override `content-type`/`content-encoding`); per-attempt timeout via `AbortController` (it also covers reading the body); retry on 429, 502, 503, 504 and network/timeout errors with exponential backoff and jitter, taking the larger of backoff and `Retry-After`; no retry on other 4xx or other statuses; any 2xx is success; a 2xx JSON body's `partialSuccess` (`rejectedSpans`, `rejectedDataPoints`, `errorMessage`) is returned as `partialSuccess` when it has any non-empty/non-zero field, else `null`; Langfuse's non-standard 200 body is tolerated. It never throws for HTTP or network failures; `error` is a short string with status or error name and never contains header values or the request body.

## 9. Deviations from the task text, per phase0

1. **Metric temporality is delta only in OTEL 1** (the workflow brief requires it); cumulative output is not implemented (section 2). Phase0 shows delta metrics sent straight to otel-lgtm are accepted and dropped silently ([phase0-findings.md Q2, Q3, §4 item 4](phase0-findings.md)).
2. **With `langfuse: true` the session span uses `gen_ai.operation.name = "chat"`** (name `chat <model or runner>`), because Langfuse ignores model, usage and cost on `invoke_agent` spans ([Q4, §4 item 5](phase0-findings.md)). Without the flag it stays `invoke_agent`.
3. Metrics are not meaningful for Langfuse (no metrics store); the caller should not enable them there ([§4](phase0-findings.md)).
4. Grafana Cloud and Datadog direct JSON are unverified ([§5](phase0-findings.md)); the generic client does not special-case them.
5. **The workflow name is treated as content.** The original task text named the root span `invoke_workflow <name>` unconditionally; because names are user text, the name (and, with it, the organization name) is exported only with `sendContent: true` (sections 1, 6).
6. **Langfuse attributes** `langfuse.user.id` and `langfuse.session.id` are on the root **and** the session span, so they survive when the root span is not yet emitted (section 3.5).
7. **`step.judged` needs a boolean `ok`**; anything else is dropped rather than exported as a guess.
8. **State shape and function names** differ from the first draft of this contract: `computeUsageDelta` (one snapshot) and `buildMetrics` (a batch) replace the planned `computeUsageDeltas`/`buildMetricsRequest`, and `buildTraces`/`sendOtlp` take a single options object (section 8).
