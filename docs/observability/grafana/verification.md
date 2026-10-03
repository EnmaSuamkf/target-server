# Dashboard verification

Verified on 2026-10-03 against the compose stack in [../compose](../compose/docker-compose.yml) (`grafana/otel-lgtm` with Grafana 13.2.2, plus the Collector), after `docker compose -f docs/observability/compose/docker-compose.yml up -d` and `node scripts/otel-demo-data.mjs` (36 workflows, 10 of them failed, 99 OTLP requests, all accepted).

- The dashboard JSON parses: `node -e "JSON.parse(require('fs').readFileSync('docs/observability/grafana/target-server-dashboard.json','utf8'))"` prints no error.
- The dashboard is provisioned: `GET /api/search` lists "Target Server - OTEL export" (uid `target-server-otel`, folder "Target Server"). The two mounts in the compose file (provider YAML and the JSON) are what load it; the `prometheus` and `tempo` datasources it uses already exist in the otel-lgtm image, so no datasource file is provisioned.
- Every panel query was read from the provisioned dashboard (`GET /api/dashboards/uid/target-server-otel`), had its template variables substituted exactly as Grafana does for "All" (`.*`) and the default rate window (15m), and was run through `POST /api/ds/query` for the last hour. The script that does this is [verify-panels.mjs](verify-panels.mjs); run it as `node docs/observability/grafana/verify-panels.mjs [grafanaUrl] [org-regex]`.

## Run 1: all organizations

```
GET /api/search lists: Target Server - OTEL export (uid target-server-otel, folder Target Server)

Variables: org=`.*`, runner=`.*`, window=`15m`; time range: last 1h; attempts: 2.

| Panel | Query ref | Result | Non-empty |
|---|---|---|---|
| Cost (USD) by org and runner | A ({{target_org}} / {{target_runner}}) | 6 frame(s), up to 109 rows | yes (431 non-zero values) |
| Workflow failure rate | A (failure rate) | 1 frame(s), up to 241 rows | yes (1 non-zero values) |
| Workflows completed vs failed | A (completed) | 1 frame(s), up to 1 rows | yes (1 non-zero values) |
| Workflows completed vs failed | B (failed) | 1 frame(s), up to 1 rows | yes (1 non-zero values) |
| Tokens per hour by token type | A ({{token_type}}) | 4 frame(s), up to 109 rows | yes (436 non-zero values) |
| Step duration p50 / p95 | A (p50) | 1 frame(s), up to 109 rows | yes (109 non-zero values) |
| Step duration p50 / p95 | B (p95) | 1 frame(s), up to 109 rows | yes (109 non-zero values) |
| Step retries | A ({{target_runner}}) | 4 frame(s), up to 78 rows | yes (189 non-zero values) |
| Recent workflows (traces) | A (traceql) | 1 frame(s), up to 20 rows | yes (100 non-zero values) |

All panel queries returned data.
```

## Run 2: organization variable set to `globex`

```
GET /api/search lists: Target Server - OTEL export (uid target-server-otel, folder Target Server)

Variables: org=`globex`, runner=`.*`, window=`15m`; time range: last 1h; attempts: 1.

| Panel | Query ref | Result | Non-empty |
|---|---|---|---|
| Cost (USD) by org and runner | A ({{target_org}} / {{target_runner}}) | 2 frame(s), up to 78 rows | yes (119 non-zero values) |
| Workflow failure rate | A (failure rate) | 1 frame(s), up to 241 rows | yes (1 non-zero values) |
| Workflows completed vs failed | A (completed) | 1 frame(s), up to 1 rows | yes (1 non-zero values) |
| Workflows completed vs failed | B (failed) | 1 frame(s), up to 1 rows | yes (1 non-zero values) |
| Tokens per hour by token type | A ({{token_type}}) | 4 frame(s), up to 78 rows | yes (312 non-zero values) |
| Step duration p50 / p95 | A (p50) | 1 frame(s), up to 78 rows | yes (78 non-zero values) |
| Step duration p50 / p95 | B (p95) | 1 frame(s), up to 78 rows | yes (78 non-zero values) |
| Step retries | A ({{target_runner}}) | 2 frame(s), up to 57 rows | yes (86 non-zero values) |
| Recent workflows (traces) | A (traceql) | 1 frame(s), up to 12 rows | yes (60 non-zero values) |

All panel queries returned data.
```

## What was learned while building it

- **Send metrics in non-overlapping slices.** The Collector's `deltatocumulative` processor discards delta datapoints whose interval overlaps the previous one of the same series. Sending one request per workflow (workflows overlap in time) lost most counters, so the demo script sends metrics per organization in consecutive one-minute slices of event time, which is how a steady exporter behaves.
- **End data near "now".** Tempo only returned traces whose end time was close to their ingestion time; demo traces backdated by many minutes were stored (trace-by-id and tag lookups worked) but not returned by TraceQL search. The demo workflows therefore all end within the last minute and started a few minutes earlier. The real exporter sends events seconds after they happen, so this does not affect production data.
- **First increment of a counter is invisible to `increase()`.** A series whose first sample is 1 shows no increase until a second sample exists. All demo workflows end within the last minute, so the demo script sends a zero-valued datapoint for `target.workflow.completed` and `target.workflow.failed` on the boundary of the one-minute slice that holds the first workflow end (as a long-running exporter would already have). With real data only the very first event of each series is affected.
- **Send the primer in time order.** Prometheus rejects a whole OTLP request with HTTP 400 when one of its samples arrives out of order for its series (the Collector then drops the request, with no error visible on the sender side). An early version sent the primer first, so later slices of the same organization carried older timestamps for shared series such as `target_info`, and roughly one clean-state run in six lost all its metrics. The primer is now sent when the sequence of slices reaches its timestamp.
- **Start-up race.** The compose healthcheck now waits for Grafana, Prometheus (`/-/ready`), Tempo (`/ready`) and the OTLP/HTTP port of otel-lgtm, not Grafana alone, and `verify-panels.mjs` retries for up to 90 seconds (`VERIFY_TIMEOUT_SECONDS`) because the backends ingest asynchronously. With both changes and the in-order primer, 30 consecutive clean-state runs (`down -v`, `up -d`, demo, `verify-panels.mjs`) all passed, followed by the run recorded above.
- **Rate window.** The `Rate window` variable (default 15m) is used by `increase`/`rate`. Use a longer window when exports are infrequent.
- `sum(counter)` without `increase` is not meaningful here: series go stale a few minutes after their last export and drop out of the sum.

## Organization names (OTEL 5)

Verified on 2026-10-04 against the stack that was already running (left running). The demo script now sends `target.org.name` the way the exporter does with Send content on: `acme` = "Acme Corp" and `globex` = "Globex Industries"; `initech` has no name and Send content off (the fallback case). The operator's older organization `2844df25-…` also shows up without a name. Prometheus and Tempo returned the attribute (see [../compose/metric-names.md](../compose/metric-names.md)), and the dashboard changed like this:

- **Organization variable** uses `query_result(...)` with the regex `/org_name="(?<text>[^"]*)",target_org="(?<value>[^"]*)"/`: the text is the name, the value stays the id (`target_org`), so every panel still filters by id. The query builds `org_name` as the name when the series has `target_org_name` and as the id otherwise, and an organization that has both old (id only) and new (named) series is listed once, by name. In the browser the dropdown listed `2844df25-0af4-4e46-b161-4dec77c16442`, `Acme Corp`, `Globex Industries` and `initech`; opening `?var-org=acme&var-org=initech` shows the chips "Acme Corp" and "initech".
- **Cost panel** legend is `{{org}} / {{target_runner}}`, where `org` is added with `label_replace` around the unchanged `increase(...)` (name, else id). The legends read "Acme Corp / claude", "initech / claude", and so on.
- **Recent workflows table** now uses the Tempo `spans` table type with `| select(resource.target.org.name, resource.target.org)` (the `traces` type keeps selected attributes in nested frames). A `calculateField` transformation builds the **Organization** column from the last non-empty of the two (Tempo returns `target.org` first, then `target.org.name`), and the workflow name column carries a data link that opens the trace in Explore (the old trace-id link of the `traces` type is not available in the `spans` type).
- **Grafana does not reload an edited provisioned file by itself** here within minutes; after editing the JSON run `curl -s -u admin:admin -X POST localhost:3000/api/admin/provisioning/dashboards/reload`.
- `verify-panels.mjs` now also evaluates the Organization variable (query plus regex) and prints the options; it counts as a failure when there are none.

### Run 3: all organizations

```
GET /api/search lists: Target Server - OTEL export (uid target-server-otel, folder Target Server)

Variables: org=`.*`, runner=`.*`, window=`15m`; time range: last 1h; attempts: 1.

| Panel | Query ref | Result | Non-empty |
|---|---|---|---|
| Cost (USD) by org and runner | A ({{org}} / {{target_runner}}) | 7 frame(s), up to 145 rows | yes (717 non-zero values) |
| Workflow failure rate | A (failure rate) | 1 frame(s), up to 241 rows | yes (38 non-zero values) |
| Workflows completed vs failed | A (completed) | 1 frame(s), up to 58 rows | yes (38 non-zero values) |
| Workflows completed vs failed | B (failed) | 1 frame(s), up to 38 rows | yes (38 non-zero values) |
| Tokens per hour by token type | A ({{token_type}}) | 4 frame(s), up to 145 rows | yes (580 non-zero values) |
| Step duration p50 / p95 | A (p50) | 1 frame(s), up to 145 rows | yes (145 non-zero values) |
| Step duration p50 / p95 | B (p95) | 1 frame(s), up to 145 rows | yes (145 non-zero values) |
| Step retries | A ({{target_runner}}) | 4 frame(s), up to 114 rows | yes (338 non-zero values) |
| Recent workflows (traces) | A (traceql) | 1 frame(s), up to 20 rows | yes (191 non-zero values) |

Organization variable options (name, with the id in parentheses; the id alone when no name was exported): 2844df25-0af4-4e46-b161-4dec77c16442, Acme Corp (acme), Globex Industries (globex), initech

All panel queries returned data.
```

### Run 4: organization variable set to `acme`

```
GET /api/search lists: Target Server - OTEL export (uid target-server-otel, folder Target Server)

Variables: org=`acme`, runner=`.*`, window=`15m`; time range: last 1h; attempts: 1.

| Panel | Query ref | Result | Non-empty |
|---|---|---|---|
| Cost (USD) by org and runner | A ({{org}} / {{target_runner}}) | 2 frame(s), up to 145 rows | yes (218 non-zero values) |
| Workflow failure rate | A (failure rate) | 1 frame(s), up to 241 rows | yes (37 non-zero values) |
| Workflows completed vs failed | A (completed) | 1 frame(s), up to 37 rows | yes (37 non-zero values) |
| Workflows completed vs failed | B (failed) | 1 frame(s), up to 37 rows | yes (37 non-zero values) |
| Tokens per hour by token type | A ({{token_type}}) | 4 frame(s), up to 145 rows | yes (580 non-zero values) |
| Step duration p50 / p95 | A (p50) | 1 frame(s), up to 145 rows | yes (145 non-zero values) |
| Step duration p50 / p95 | B (p95) | 1 frame(s), up to 145 rows | yes (145 non-zero values) |
| Step retries | A ({{target_runner}}) | 2 frame(s), up to 114 rows | yes (179 non-zero values) |
| Recent workflows (traces) | A (traceql) | 1 frame(s), up to 20 rows | yes (200 non-zero values) |

Organization variable options (name, with the id in parentheses; the id alone when no name was exported): 2844df25-0af4-4e46-b161-4dec77c16442, Acme Corp (acme), Globex Industries (globex), initech

All panel queries returned data.
```
