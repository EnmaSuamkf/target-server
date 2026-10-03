# Langfuse OTLP/HTTP JSON verification

Environment: official Langfuse docker compose (downloaded from `https://raw.githubusercontent.com/langfuse/langfuse/main/docker-compose.yml`, unmodified, kept in `langfuse/docker-compose.yml`; images `docker.langfuse.com/langfuse/langfuse:4` and `langfuse-worker:4`). Health endpoint reported **version 4.50.0** (requirement: >= 3.22.0): `GET /api/public/health` -> `{"status":"OK","version":"4.50.0"}`.
Started with `docker compose --env-file .env.example up -d` in `docs/observability/phase0/langfuse/`. Org, project and API keys were created headlessly with the documented `LANGFUSE_INIT_*` variables (https://langfuse.com/self-hosting/administration/headless-initialization). The values in `langfuse/.env.example` are obvious local-only dummies (`pk-lf-phase0-local-dummy` / `sk-lf-phase0-local-dummy`); no real credential exists in this repo.
Requests used header `Authorization: Basic base64(pk:sk)` and `x-langfuse-ingestion-version: 4` through `OTLP_HEADERS` in `send.mjs`, `Content-Type: application/json`, and `--now` timestamps.
The stack was stopped with `docker compose down -v` afterwards.

## Summary

| # | Probe | Request | HTTP status | Response body | Verdict |
|---|-------|---------|-------------|---------------|---------|
| 1 | Trace JSON with langfuse.* attributes | POST :3000/api/public/otel/v1/traces payloads/trace.json | 200 | `{"name":"otel-ingestion-job",...}` (BullMQ job echo, full text below) | PASS for transport, user, session, observation types and hierarchy. **Model, usage and cost were NOT mapped** on the `invoke_agent` span (see Quirk 1) |
| 2 | Trace JSON WITHOUT langfuse.* (only gen_ai.* and target.*) | POST :3000/api/public/otel/v1/traces payloads/trace-no-langfuse.json | 200 | `{"name":"otel-ingestion-job",...}` (full body in "Raw send output") | PASS for transport. `gen_ai.conversation.id` became sessionId; user is empty; target.* and gen_ai.* landed in metadata |
| 3 | Metrics JSON | POST :3000/api/public/otel/v1/metrics payloads/metrics-sum-cumulative.json | 200 | `{"message":"OK"}` | Accepted, but Langfuse has no metrics store. Nothing to query. Do not send metrics to Langfuse |
| 4 | Mapping probe A: chat span, CLIENT kind, only gen_ai.* (model + input/output tokens) | POST payloads/probe-langfuse-mapping.json | 200 | `{"name":"otel-ingestion-job",...}` (full body in "Mapping probe sends") | PASS. model, usage and an auto-calculated cost (0.0087) appeared |
| 5 | Mapping probe B/C: type=generation + model.name (+ usage_details + cost_details JSON) | same file | 200 | `{"name":"otel-ingestion-job",...}` (full body in "Mapping probe sends") | PASS. usage {"input":1200,"output":340,"total":1540}, cost {"total":0.0123} |
| 6 | Mapping probe D: `gen_ai.usage.cost` | same file | 200 | `{"name":"otel-ingestion-job",...}` (full body in "Mapping probe sends") | Accepted but cost stayed 0. Do not rely on it |
| 7 | Mapping probe E-H: step-1 attributes combined with different gen_ai.operation.name | POST payloads/probe-langfuse-mapping2.json | 200 | `{"name":"otel-ingestion-job",...}` (full body in "Mapping probe sends") | Reproduced the quirk: `invoke_agent` drops model/usage/cost, `chat` (or no operation name) keeps them |

## Quirks found

1. **`gen_ai.operation.name = invoke_agent` makes Langfuse ignore model, usage and cost** on that span, even when `langfuse.observation.type=generation` and valid `langfuse.observation.usage_details`/`cost_details` are present (probe E and H). The same attributes with `gen_ai.operation.name=chat` (probe G) or with the operation name removed (probe F) are mapped correctly. Put tokens, model and cost on a span whose operation is `chat`, and keep `invoke_agent`/`invoke_workflow` for structural spans.
2. In Langfuse v4 ("events_only" mode) the old read endpoints are gone: `GET /api/public/traces`, `/api/public/traces/{id}` and `/api/public/observations` return HTTP 404 `{"message":"This endpoint is not available on deployments running in Langfuse v4 events_only mode. ..."}`. The working read API is `GET /api/public/v2/observations?traceId=...&fields=core,basic,time,io,metadata,model,usage,prompt,metrics`. There is no v2 traces endpoint (404 HTML).
3. The OTLP response is not the OTLP-standard `{"partialSuccess":{}}`: for traces it is a JSON echo of the queued ingestion job, for metrics `{"message":"OK"}`. Treat any 2xx as success.
4. Ingestion is asynchronous (queue + worker): data was queryable within about 25-30 seconds, not instantly.
5. Both traces were accepted and stored without any special handling of the integer-as-string `intValue` encoding.
6. Observation types seen: spans with `langfuse.observation.type=generation` -> GENERATION; `execute_tool` -> TOOL; `invoke_agent` without langfuse.* -> AGENT; `invoke_workflow` -> SPAN (root, `isRootObservation: true`). ERROR status -> `level: "ERROR"` plus `statusMessage`.
7. Attributes without the `langfuse.*` prefix (including `target.cost.usd` and `target.org`) end up in `metadata` with prefixes `attributes.` and `resourceAttributes.`; they are not first-class fields.

## Raw send output (`send.mjs`, headers via OTLP_HEADERS, values not printed)

```
== with langfuse.* (trace.json)
HTTP 200 OK
{"name":"otel-ingestion-job","data":{"id":"d185b9af-d1ed-4188-9a9f-ecc60d2f4651","timestamp":"2026-10-03T16:21:54.200Z","name":"otel-ingestion-job","payload":{"data":{"fileKey":"events/otel/phase0-project/2026/10/03/16/21/0e73d966-062f-4dc2-b69d-9135d38c1751.json","publicKey":"pk-lf-phase0-local-dummy"},"authCheck":{"validKey":true,"scope":{"projectId":"phase0-project","accessLevel":"project","orgId":"phase0-org"}},"sdkName":"unknown","sdkVersion":"unknown","ingestionVersion":"4"}},"opts":{"attempts":6,"removeOnComplete":true,"removeOnFail":100000,"backoff":{"type":"exponential","delay":5000},"traceparent":"00-ee28d1d287ceb4d9ae20458f82456d57-24833627868cd793-01","baggage":"langfuse.header.x-langfuse-ingestion-version=4,langfuse.clickhouse.surface=publicapi,langfuse.clickhouse.route=POST%20%2Fapi%2Fpublic%2Fotel%2Fv1%2Ftraces,langfuse.clickhouse.user_agent=node,langfuse.project.id=phase0-project,langfuse.api_key.id=cmuslncan0001ql074g55qi48"},"id":"1","progress":0,"returnvalue":null,"stacktrace":null,"priority":0,"attemptsStarted":0,"attemptsMade":0,"stalledCounter":0,"timestamp":1791044514213,"queueQualifiedName":"bull:otel-ingestion-queue"}
== without langfuse.* (trace-no-langfuse.json)
HTTP 200 OK
{"name":"otel-ingestion-job","data":{"id":"2527c284-2b06-4905-a53b-0a872bb1c8d7","timestamp":"2026-10-03T16:21:54.468Z","name":"otel-ingestion-job","payload":{"data":{"fileKey":"events/otel/phase0-project/2026/10/03/16/21/b62d62b8-656f-4cc0-b1e9-2d8fe3116f2b.json","publicKey":"pk-lf-phase0-local-dummy"},"authCheck":{"validKey":true,"scope":{"projectId":"phase0-project","accessLevel":"project","orgId":"phase0-org"}},"sdkName":"unknown","sdkVersion":"unknown","ingestionVersion":"4"}},"opts":{"attempts":6,"removeOnComplete":true,"removeOnFail":100000,"backoff":{"type":"exponential","delay":5000},"traceparent":"00-ecbed7104fd85640c34672c0d3b9aabe-92ee6c8a5504a743-01","baggage":"langfuse.header.x-langfuse-ingestion-version=4,langfuse.clickhouse.surface=publicapi,langfuse.clickhouse.route=POST%20%2Fapi%2Fpublic%2Fotel%2Fv1%2Ftraces,langfuse.clickhouse.user_agent=node,langfuse.project.id=phase0-project,langfuse.api_key.id=cmuslncan0001ql074g55qi48"},"id":"2","progress":0,"returnvalue":null,"stacktrace":null,"priority":0,"attemptsStarted":0,"attemptsMade":0,"stalledCounter":0,"timestamp":1791044514468,"queueQualifiedName":"bull:otel-ingestion-queue"}
== metrics (not supported by Langfuse?)
HTTP 200 OK
{"message":"OK"}
```

## Read API: trace.json (WITH langfuse.*), trace id 5b8efff798038103d269b633813fc60c

Command: `curl -u pk:sk -G http://localhost:3000/api/public/v2/observations --data-urlencode traceId=5b8efff798038103d269b633813fc60c --data-urlencode fields=core,basic,model,usage,metadata`

```
Bash | type=TOOL | parent=eee19b7ec3c1b174 | userId="" | sessionId="session-demo-1" | model="" | usageDetails={"input":0,"total":0} | costDetails={} | totalCost=null
invoke_agent step-1 | type=GENERATION | parent=eee19b7ec3c1b174 | userId="" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
invoke_workflow demo | type=SPAN | parent=- | userId="alice@example.com" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
```

Metadata keys on the spans (proves where the langfuse.* attributes ended up when not consumed):

```
Bash: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.gen_ai.usage.input_tokens, attributes.gen_ai.conversation.id, attributes.gen_ai.tool.name, attributes.gen_ai.operation.name
invoke_agent step-1: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.langfuse.observation.cost_details, attributes.langfuse.observation.usage_details, attributes.langfuse.observation.model.name, attributes.langfuse.observation.type, attributes.gen_ai.usage.cache_write.input_tokens, attributes.gen_ai.usage.cache_read.input_tokens, attributes.gen_ai.usage.output_tokens, attributes.gen_ai.usage.input_tokens, attributes.gen_ai.conversation.id, attributes.gen_ai.request.model, attributes.gen_ai.provider.name, attributes.gen_ai.operation.name
invoke_workflow demo: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.langfuse.trace.name, attributes.langfuse.session.id, attributes.langfuse.user.id, attributes.gen_ai.conversation.id, attributes.gen_ai.provider.name, attributes.gen_ai.operation.name
```

Result: **user id `alice@example.com` and session id `session-demo-1` are present on the root observation** (from `langfuse.user.id` and `langfuse.session.id`); the trace name attribute is kept in metadata. The generation span has type GENERATION but **empty model, usage and cost** because of Quirk 1 (probe results below show the fix).

## Read API: trace-no-langfuse.json (WITHOUT langfuse.*), trace id 6c9f00089a149214e37ac744924fd71d

```
Bash | type=TOOL | parent=eee19b7ec3c1b174 | userId="" | sessionId="session-demo-1" | model="" | usageDetails={"input":0,"total":0} | costDetails={} | totalCost=null
invoke_agent step-1 | type=AGENT | parent=eee19b7ec3c1b174 | userId="" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
invoke_workflow demo | type=SPAN | parent=- | userId="" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
```

```
Bash: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.gen_ai.usage.input_tokens, attributes.gen_ai.conversation.id, attributes.gen_ai.tool.name, attributes.gen_ai.operation.name
invoke_agent step-1: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.gen_ai.usage.cache_write.input_tokens, attributes.gen_ai.usage.cache_read.input_tokens, attributes.gen_ai.usage.output_tokens, attributes.gen_ai.usage.input_tokens, attributes.gen_ai.conversation.id, attributes.gen_ai.request.model, attributes.gen_ai.provider.name, attributes.gen_ai.operation.name
invoke_workflow demo: metadata keys = scope.version, scope.name, resourceAttributes.target.org, resourceAttributes.service.name, attributes.target.cost.usd, attributes.gen_ai.conversation.id, attributes.gen_ai.provider.name, attributes.gen_ai.operation.name
```

## Comparison with and without langfuse.* attributes

| Field | With langfuse.* | Without langfuse.* (only gen_ai.* and target.*) |
|-------|-----------------|---------------------------------------------------|
| User id | `alice@example.com` on the root observation | empty (`""`) |
| Session id | `session-demo-1` | `session-demo-1` (inferred from `gen_ai.conversation.id`) |
| Trace name | kept only in metadata (`attributes.langfuse.trace.name`) | root observation name `invoke_workflow demo` |
| step-1 observation type | GENERATION (from `langfuse.observation.type`) | AGENT (from `gen_ai.operation.name=invoke_agent`) |
| Model | empty (Quirk 1, `invoke_agent`) | empty |
| Usage / cost | empty (Quirk 1) | empty |
| `gen_ai.*`, `target.*`, resource attributes | in metadata | in metadata |

## Mapping probe sends (full status and body)

The two mapping-probe requests were first sent with only the status line captured. To keep the evidence exact they were re-sent on a freshly started Langfuse 4.50.0 (same compose, same dummy keys, then removed again with `docker compose down -v`); the full output follows. The read-API results of the re-run were identical to the first run (the observation summaries below are from the re-run):

```
== POST :3000/api/public/otel/v1/traces payloads/probe-langfuse-mapping.json --now
HTTP 200 OK
{"name":"otel-ingestion-job","data":{"id":"2cfbc13d-63e6-489a-8c01-5979f6adf42f","timestamp":"2026-10-03T16:29:23.253Z","name":"otel-ingestion-job","payload":{"data":{"fileKey":"events/otel/phase0-project/2026/10/03/16/29/9002caf0-5f8a-4925-95e3-c78c7053aca0.json","publicKey":"pk-lf-phase0-local-dummy"},"authCheck":{"validKey":true,"scope":{"projectId":"phase0-project","accessLevel":"project","orgId":"phase0-org"}},"sdkName":"unknown","sdkVersion":"unknown","ingestionVersion":"4"}},"opts":{"attempts":6,"removeOnComplete":true,"removeOnFail":100000,"backoff":{"type":"exponential","delay":5000},"traceparent":"00-a0e438dc6d41a052ae9de6c6101fdda7-06b60361a224acfb-01","baggage":"langfuse.header.x-langfuse-ingestion-version=4,langfuse.clickhouse.surface=publicapi,langfuse.clickhouse.route=POST%20%2Fapi%2Fpublic%2Fotel%2Fv1%2Ftraces,langfuse.clickhouse.user_agent=node,langfuse.project.id=phase0-project,langfuse.api_key.id=cmuslx8lj0001lh07541ozcti"},"id":"1","progress":0,"returnvalue":null,"stacktrace":null,"priority":0,"attemptsStarted":0,"attemptsMade":0,"stalledCounter":0,"timestamp":1791044963259,"queueQualifiedName":"bull:otel-ingestion-queue"}
== POST :3000/api/public/otel/v1/traces payloads/probe-langfuse-mapping2.json --now
HTTP 200 OK
{"name":"otel-ingestion-job","data":{"id":"c3ad9cd4-5e1d-44fc-8471-7dc9dfc72281","timestamp":"2026-10-03T16:29:23.402Z","name":"otel-ingestion-job","payload":{"data":{"fileKey":"events/otel/phase0-project/2026/10/03/16/29/34bd876a-4b24-426f-808f-610988be56eb.json","publicKey":"pk-lf-phase0-local-dummy"},"authCheck":{"validKey":true,"scope":{"projectId":"phase0-project","accessLevel":"project","orgId":"phase0-org"}},"sdkName":"unknown","sdkVersion":"unknown","ingestionVersion":"4"}},"opts":{"attempts":6,"removeOnComplete":true,"removeOnFail":100000,"backoff":{"type":"exponential","delay":5000},"traceparent":"00-ff1e2729d234c796698832896ce367ae-67e8cdcfeebe4690-01","baggage":"langfuse.header.x-langfuse-ingestion-version=4,langfuse.clickhouse.surface=publicapi,langfuse.clickhouse.route=POST%20%2Fapi%2Fpublic%2Fotel%2Fv1%2Ftraces,langfuse.clickhouse.user_agent=node,langfuse.project.id=phase0-project,langfuse.api_key.id=cmuslx8lj0001lh07541ozcti"},"id":"2","progress":0,"returnvalue":null,"stacktrace":null,"priority":0,"attemptsStarted":0,"attemptsMade":0,"stalledCounter":0,"timestamp":1791044963402,"queueQualifiedName":"bull:otel-ingestion-queue"}
```

Re-run read API output (probe 1 = trace 7d0a1119..., probe 2 = trace 8e1b222a...):

```
D gen_ai.usage.cost | GENERATION | model="claude-sonnet-4-5" | usage={"input":10,"total":10} | cost={"total":0} 0
C langfuse usage+cost json | GENERATION | model="claude-sonnet-4-5" | usage={"input":1200,"output":340,"total":1540} | cost={"total":0.0123} 0.0123
B langfuse type+model only | GENERATION | model="claude-sonnet-4-5" | usage={} | cost={} null
A gen_ai only (chat, CLIENT) | GENERATION | model="claude-sonnet-4-5" | usage={"input":1200,"output":340,"total":1540} | cost={"input":0.0036,"output":0.0051,"total":0.0087} 0.0087

H without cache_* usage keys in usage_details | GENERATION | model="" | usage={} | cost={} null
G operation.name=chat | GENERATION | model="claude-sonnet-4-5" | usage={"input":1200,"output":340,"cache_read_input_tokens":800,"cache_creation_input_tokens":100,"total":2440} | cost={"total":0.0123} 0.0123
F without gen_ai.operation.name | GENERATION | model="claude-sonnet-4-5" | usage={"input":1200,"output":340,"cache_read_input_tokens":800,"cache_creation_input_tokens":100,"total":2440} | cost={"total":0.0123} 0.0123
E full step-1 as in trace.json | GENERATION | model="" | usage={} | cost={} null
```

## Mapping probes (distinct trace ids, same ingestion path; first run)

Probe 1 (`payloads/probe-langfuse-mapping.json`, trace 7d0a11199b25a325f48bd855a35be82e):

```
D gen_ai.usage.cost | type=GENERATION | parent=- | userId="" | sessionId="" | model="claude-sonnet-4-5" | usageDetails={"input":10,"total":10} | costDetails={"total":0} | totalCost=0
C langfuse usage+cost json | type=GENERATION | parent=- | userId="" | sessionId="" | model="claude-sonnet-4-5" | usageDetails={"input":1200,"output":340,"total":1540} | costDetails={"total":0.0123} | totalCost=0.0123
B langfuse type+model only | type=GENERATION | parent=- | userId="" | sessionId="" | model="claude-sonnet-4-5" | usageDetails={} | costDetails={} | totalCost=null
A gen_ai only (chat, CLIENT) | type=GENERATION | parent=- | userId="" | sessionId="" | model="claude-sonnet-4-5" | usageDetails={"input":1200,"output":340,"total":1540} | costDetails={"input":0.0036,"output":0.0051,"total":0.0087} | totalCost=0.0087
```

Probe 2 (`payloads/probe-langfuse-mapping2.json`, trace 8e1b222a0c36b436a59ce966b46cf93f; E = step-1 exactly as in trace.json, F = no operation name, G = operation chat, H = usage_details without cache keys but still invoke_agent):

```
H without cache_* usage keys in usage_details | type=GENERATION | parent=- | userId="" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
G operation.name=chat | type=GENERATION | parent=- | userId="" | sessionId="session-demo-1" | model="claude-sonnet-4-5" | usageDetails={"input":1200,"output":340,"cache_read_input_tokens":800,"cache_creation_input_tokens":100,"total":2440} | costDetails={"total":0.0123} | totalCost=0.0123
F without gen_ai.operation.name | type=GENERATION | parent=- | userId="" | sessionId="session-demo-1" | model="claude-sonnet-4-5" | usageDetails={"input":1200,"output":340,"cache_read_input_tokens":800,"cache_creation_input_tokens":100,"total":2440} | costDetails={"total":0.0123} | totalCost=0.0123
E full step-1 as in trace.json | type=GENERATION | parent=- | userId="" | sessionId="session-demo-1" | model="" | usageDetails={} | costDetails={} | totalCost=null
```

Conclusions: with `gen_ai.operation.name=chat` (probe G) the full path works: model `claude-sonnet-4-5`, usage {input 1200, output 340, cache_read_input_tokens 800, cache_creation_input_tokens 100, total 2440} and cost {"total":0.0123} supplied through `langfuse.observation.cost_details`. With only `gen_ai.*` (probe A) Langfuse infers the generation, usage and calculates the cost itself from its model price table (0.0087 for 1200 in / 340 out on claude-sonnet-4-5), so sending explicit cost_details is only needed to override that.
