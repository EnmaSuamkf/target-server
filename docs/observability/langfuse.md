# Sending target-server traces to Langfuse

Langfuse shows each workflow as a trace, each agent session as a generation with model, token usage and cost, and groups traces by user and session. Langfuse has **no metrics store**, so only the **Traces** signal is useful here.

How to read the labels in this guide (same vocabulary as [phase0-findings.md](phase0-findings.md)):

- **PASS / FAIL**: measured in the OTEL 0 spike or in OTEL 4 against a real Langfuse 4.50.0 (self-hosted, official compose).
- **NOT TESTED**: not run against that environment.
- **unverified**: not stated by the official page that is linked, and not measured by us.
- Each technical claim carries the official page it comes from. "(measured)" means it comes from our own test, not from the docs.

| Check | Result |
|---|---|
| Traces, OTLP/HTTP JSON, Langfuse 4.50.0 self-hosted | **PASS** ([phase0-findings.md](phase0-findings.md) Q4, repeated in OTEL 4 with the demo script: 6 of 6 requests accepted, generations with model, usage and cost visible through the read API) |
| Metrics | **FAIL**: HTTP 200 `{"message":"OK"}` but nothing is stored (measured, [phase0-findings.md](phase0-findings.md) Q4). Keep Metrics off |
| Langfuse Cloud (any region) | **NOT TESTED** (no credentials in the environment); the endpoints below come from the docs |

## Endpoints

| Where | OTLP base URL | Source |
|---|---|---|
| Cloud, EU | `https://cloud.langfuse.com/api/public/otel` | <https://langfuse.com/integrations/native/opentelemetry> |
| Cloud, US | `https://us.cloud.langfuse.com/api/public/otel` | <https://langfuse.com/integrations/native/opentelemetry> |
| Cloud, Japan | `https://jp.cloud.langfuse.com/api/public/otel` | <https://langfuse.com/integrations/native/opentelemetry> |
| Cloud, HIPAA | `https://hipaa.cloud.langfuse.com/api/public/otel` | <https://langfuse.com/integrations/native/opentelemetry> |
| Self-hosted | `http://localhost:3000/api/public/otel` (the docs' example; use your own host). Requires Langfuse v3.22.0 or later | <https://langfuse.com/integrations/native/opentelemetry> |

- Langfuse supports OTLP over HTTP with both JSON and protobuf. gRPC is not supported. Source: <https://langfuse.com/integrations/native/opentelemetry>. target-server sends OTLP/HTTP JSON (see [otel-mapping.md](otel-mapping.md) section 5).
- A signal-specific path `/api/public/otel/v1/traces` also exists "for collectors requiring signal-specific configuration". Source: <https://langfuse.com/integrations/native/opentelemetry>. target-server appends `/v1/traces` itself, so enter the base URL above.
- The OTLP default ports and `/v1/traces` / `/v1/metrics` paths are defined by the OTLP specification: <https://opentelemetry.io/docs/specs/otlp/>.

## Headers

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Basic <base64(publicKey:secretKey)>` | <https://langfuse.com/integrations/native/opentelemetry> |
| `x-langfuse-ingestion-version` | `4` | <https://langfuse.com/integrations/native/opentelemetry> (the docs say it enables real-time ingestion in Langfuse v4 and avoids delays of up to 10 minutes) |

Build the Authorization value (GNU `base64` needs `-w 0` to avoid line wrapping; source for the command and the flag: <https://langfuse.com/integrations/native/opentelemetry>):

```
echo -n "pk-lf-...:sk-lf-..." | base64 -w 0
```

Then the header value is `Basic ` followed by that output. The public key is the Basic-auth username and the secret key the password (<https://langfuse.com/docs/api-and-data-platform/features/public-api>). The keys are in the Langfuse project settings (same page; the exact menu path is **unverified**).

Both headers were required in our test; the response to a trace export is HTTP 200 with a JSON echo of the queued ingestion job, not the standard `{"partialSuccess":{}}`, and the data appears after about 25 to 30 seconds (measured, [phase0-findings.md](phase0-findings.md) Q4). Any 2xx counts as success for the exporter.

## How the data maps (langfuse.* vs gen_ai.*)

Langfuse reads these attributes (official table: <https://langfuse.com/integrations/native/opentelemetry>):

| Langfuse field | OpenTelemetry attributes |
|---|---|
| user | `langfuse.user.id`, `user.id` |
| session | `langfuse.session.id`, `session.id` |
| trace name | `langfuse.trace.name`, or the root span name |
| observation type | `langfuse.observation.type` first; otherwise inferred from `gen_ai.operation.name`, model attributes, else `span` |
| model | `langfuse.observation.model.name`, `gen_ai.request.model`, `gen_ai.response.model`, `llm.model_name`, `model` |
| usage | `langfuse.observation.usage_details`, `gen_ai.usage.*`, `llm.token_count.*` |
| cost | `langfuse.observation.cost_details`, `gen_ai.usage.cost` |

Things we measured that the official page does **not** state (all in [phase0-findings.md](phase0-findings.md) Q4):

- A span with `gen_ai.operation.name = invoke_agent` loses model, usage and cost in Langfuse even when `langfuse.observation.type = generation` is set. With `chat` they are mapped.
- `gen_ai.usage.cost` was accepted but the cost stayed 0; `langfuse.observation.cost_details` worked.
- Attributes that Langfuse does not consume (`target.*`, other `gen_ai.*`, resource attributes) end up in the observation `metadata` under `attributes.` and `resourceAttributes.` keys; they are not filterable fields.

### What "Add Langfuse attributes" does

The switch in the dashboard panel (`langfuseAttrs` in the settings API, [../otel-export.md](../otel-export.md)) changes the export like this ([otel-mapping.md](otel-mapping.md) sections 3.4, 3.5 and 9):

- Root span (the workflow): adds `langfuse.user.id` (the user that sent the events, omitted when unknown), `langfuse.session.id` (the workflow id) and `langfuse.trace.name`.
- Session span (one agent session): adds `langfuse.user.id`, `langfuse.session.id`, `langfuse.observation.type = generation`, `langfuse.observation.usage_details` (input, output, cache read, cache creation) and `langfuse.observation.cost_details` (`{"total": usd}`, omitted when the session is unpriced).
- The session span switches from `gen_ai.operation.name = invoke_agent` to `chat` and is named `chat <model or runner>`, because of the measured quirk above.

Without the switch, the traces still arrive and Langfuse infers sessions from `gen_ai.conversation.id`, but users stay empty and model, usage and cost are not populated (measured, [phase0-findings.md](phase0-findings.md) Q4). The attributes are harmless for other backends.

Cost note: target-server exports the cost it computed from its pricing rules. When a session is **unpriced** (no matching rule) no `cost_details` is sent, and Langfuse may fill in a cost from its own model price table (seen once in the OTEL 4 demo for the unpriced `copilot` runner; the exact rule is **unverified**). Editing a price rule in target-server never reprices data that was already exported.

## Fill in the form (dashboard, Settings, Telemetry export)

1. Press the **Langfuse** preset. It pre-fills (nothing is saved yet):
   - Endpoint URL: `https://cloud.langfuse.com/api/public/otel` (EU). Replace it for another region or for your self-hosted host, keeping `/api/public/otel`.
   - Headers: `Authorization` (empty) and `x-langfuse-ingestion-version` = `4`.
   - Signals: **Traces** only.
   - **Add Langfuse attributes**: on.
2. Type the `Authorization` value: `Basic <base64(pk:sk)>` as built above. It is stored encrypted and only the last 4 characters are shown afterwards.
3. **Send content** is on by default for a new configuration. It adds only the workflow name and the organization name (`target.org.name`); uncheck it if Langfuse should not see them. Step descriptions, acceptance criteria, error messages and conversation content are never exported, whatever you choose (see [otel-mapping.md](otel-mapping.md) section 6).
4. Turn **Enabled** on, press **Save**, then **Test connection**. The test sends one span to the saved endpoint.
5. A self-hosted Langfuse on `localhost` or a private address needs the server operator to set `TARGET_OTEL_ALLOW_PRIVATE=1` (plain `http` is refused otherwise; see [../otel-export.md](../otel-export.md)).
6. Only events received after you enable the export are sent.

## Try it locally

[compose/langfuse/](compose/langfuse/) holds Langfuse's official `docker-compose.yml`, unmodified (copy of the file in the `langfuse/langfuse` repository, which phase 0 and OTEL 4 checked against the docs at <https://langfuse.com/self-hosting/deployment/docker-compose>), plus two small additions: an override that moves the UI to port 3001 (Grafana uses 3000 in the other stack) and an `.env.example` with throwaway keys for headless initialization (<https://langfuse.com/self-hosting/administration/headless-initialization>).

```
cd docs/observability/compose/langfuse
docker compose -f docker-compose.yml -f docker-compose.local-ports.yml --env-file .env.example up -d
# wait until http://localhost:3001/api/public/health answers, then from the repository root:
AUTH=$(printf 'pk-lf-target-demo-local:sk-lf-target-demo-local' | base64 -w 0)
OTLP_HEADERS="Authorization=Basic $AUTH,x-langfuse-ingestion-version=4" \
  node scripts/otel-demo-data.mjs --langfuse --endpoint http://localhost:3001/api/public/otel
docker compose -f docker-compose.yml -f docker-compose.local-ports.yml --env-file .env.example down -v
```

The keys above are local dummies. Langfuse's own docs say this Docker Compose setup is for trying Langfuse and development only, not production, and that the lines marked `# CHANGEME` must get long random values (<https://langfuse.com/self-hosting/deployment/docker-compose>). Langfuse needs about 2 to 3 minutes to become ready (same page).

To read the result back with the API (Langfuse v4 removed the old read endpoints, measured in [phase0-findings.md](phase0-findings.md) Q4):

```
curl -u pk-lf-target-demo-local:sk-lf-target-demo-local -G http://localhost:3001/api/public/v2/observations \
  --data-urlencode type=GENERATION --data-urlencode fields=core,basic,model,usage
```
