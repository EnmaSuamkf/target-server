# Metric names as stored in Prometheus (observed, not guessed)

Observed on 2026-10-03 against the stack in this directory: `grafana/otel-lgtm` (Grafana 13.2.2, Prometheus inside) behind `otel/opentelemetry-collector-contrib` 0.161.0 with the `deltatocumulative` processor. Data came from `node scripts/otel-demo-data.mjs` (3 orgs, 5 runners/models, 24 workflows per run). Names were read with the Grafana datasource proxy, e.g.:

```
curl -s -u admin:admin localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/label/__name__/values
curl -s -u admin:admin -G localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/series --data-urlencode 'match[]=target_tokens_total'
```

OTLP names (see [../otel-mapping.md](../otel-mapping.md) section 2) become these Prometheus names:

| OTLP metric | Prometheus name | Type | Labels (besides `job`, `service_name`, `service_version`) |
|---|---|---|---|
| `target.tokens` (`{token}`) | `target_tokens_total` | counter | `target_org`, `target_runner`, `gen_ai_request_model`, `token_type` (`input`, `output`, `cache_read`, `cache_creation`) |
| `target.cost.usd` (`USD`) | `target_cost_usd_USD_total` (note the doubled unit) | counter | `target_org`, `target_runner`, `gen_ai_request_model` |
| `target.step.duration` (`s`) | `target_step_duration_seconds_bucket`, `_count`, `_sum` | histogram | `target_org`, `target_runner`, `le` |
| `target.step.retries` (`{retry}`) | `target_step_retries_total` | counter | `target_org`, `target_runner` |
| `target.workflow.completed` (`{workflow}`) | `target_workflow_completed_total` | counter | `target_org`, `target_runner` |
| `target.workflow.failed` (`{workflow}`) | `target_workflow_failed_total` | counter | `target_org`, `target_runner` |

Rules observed: dots become underscores, the `s` unit becomes `_seconds`, `USD` is appended verbatim and then `_total` is added to monotonic sums, `{token}`/`{retry}`/`{workflow}` annotation units add nothing. Step and workflow metrics carry no model label (by design). The resource attribute `target.org` shows up as the label `target_org` because it is also set on every data point.

The `target_step_duration_seconds_bucket` series use the exporter bounds `1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600` plus `+Inf`. The `le` label also exists on other metrics of the same Prometheus, so always select by metric name before aggregating over `le`.

## Behaviors that matter for dashboard queries

- **Use range queries.** Instant queries at "now" returned nothing for these counters in the demo (the Collector only emits a series when new data arrives, and Prometheus then sees a stale series), while Grafana range queries over the last hour or three returned the data. Grafana panels are range queries, so this only affects hand-made `curl` checks: use `/api/v1/query_range`.
- **Demo data is bursty** (one export per workflow, minutes apart in sparse series). `increase(...[5m])` and `rate(...[5m])` returned no series; windows of `[30m]` did. Production data from the outbox worker is steadier, but panels should not use very short windows.
- **Backfill limit.** Samples older than roughly one hour are rejected by Prometheus (an early demo run backdated by 90 minutes produced traces but no metrics). The demo script therefore ends every workflow within the last minute (see [../grafana/verification.md](../grafana/verification.md) for why: Tempo also stops returning backdated traces, and per-series delta intervals must not overlap).
- **Unpriced runner.** The demo's `copilot` runner has no price rule: it has `target_tokens_total` series but no `target_cost_usd_USD_total` series.
- Delta metrics sent straight to `localhost:14318` (otel-lgtm without the Collector) are accepted with HTTP 200 and dropped ([../phase0-findings.md](../phase0-findings.md) Q2).

## Traces in Tempo

- Datasource uid `tempo`; root spans are named `invoke_workflow`, children `step <n>` and `invoke_agent <runner>`.
- TraceQL search that works: `{ resource.service.name = "target-server" && name =~ "invoke_workflow.*" }` (also `{ span.gen_ai.operation.name = "invoke_workflow" }`).
- Tag lookup `GET /api/datasources/proxy/uid/tempo/api/v2/search/tag/span.target.workflow.id/values` listed all 60 demo workflow ids of the first three runs.
- Search finds a trace within about 20 seconds of ingestion **only if its end time is close to the ingestion time**; traces that ended long before being sent are stored (tag lookup and trace-by-id work) but not returned by TraceQL search. Real exports are near-real-time, so this only affects backdated test data.

## Prometheus label values seen

`target_org`: `acme`, `globex`, `initech`; `target_org_name`: `Acme Corp`, `Globex Industries` (see below). `token_type`: `cache_creation`, `cache_read`, `input`, `output`. `gen_ai_request_model`: `claude-opus-4-1`, `claude-sonnet-4-5`, `gpt-5`, `gpt-5-mini`, `qwen3-coder`.

## The organization name (`target.org.name`)

Observed on 2026-10-04 after `node scripts/otel-demo-data.mjs` (Send content on for `acme` = "Acme Corp" and `globex` = "Globex Industries", off for `initech`):

- **Prometheus label: `target_org_name`.** It is on every `target_*` series (set as a data point attribute) **and** on `target_info` (from the resource). `label/target_org_name/values` returned `Acme Corp` and `Globex Industries`; `count by (target_org, target_org_name) (target_tokens_total)` returned `{target_org="acme", target_org_name="Acme Corp"}`, `{target_org="globex", target_org_name="Globex Industries"}` and, for `initech` (and for older data), only `{target_org="initech"}`: **a series without the name simply has no `target_org_name` label** (it is not empty-valued), so use `label_replace` or `{target_org_name=""}` to fall back to the id.
- **Tempo: `resource.target.org.name`** (resource scope; the tag list for scope `resource` is `service.name`, `service.version`, `target.org`, `target.org.name`). `GET .../api/v2/search/tag/resource.target.org.name/values` returned `Acme Corp` and `Globex Industries`, and TraceQL `{ resource.target.org.name = "Acme Corp" }` finds the traces. A `spans`-type search with `| select(resource.target.org.name, resource.target.org)` returns the two as columns `target.org.name` (null without a name) and `target.org`.
- Cardinality does not change: the name is 1:1 with `target_org`.
- `target_org_name` appears in label values only for organizations that have Send content on; `initech`, whose export has it off, has none.
