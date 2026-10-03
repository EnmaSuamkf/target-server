#!/usr/bin/env node
// Send realistic sample workflows to an OTLP/HTTP endpoint using the real
// exporter code (otel.mjs builds the payloads, otel-client.mjs sends them).
// No dependencies; the server database is never opened.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const USAGE = `Usage: node scripts/otel-demo-data.mjs [options]

Builds sample workflows (several orgs, runners and models, successful and
failed workflows, step retries, cost values, one unpriced runner) and sends
traces and metrics to an OTLP/HTTP endpoint.

Options:
  --endpoint <url>        OTLP/HTTP base URL (default http://localhost:4318,
                          or OTEL_DEMO_ENDPOINT)
  --workflows <n>         number of workflows to generate (default 36)
  --langfuse              Langfuse mode: traces only, with langfuse.* attributes
  --no-send-content       behave like an organization with Send content off:
                          no workflow names and no target.org.name for anyone
  --help, -h              show this help

Environment:
  OTLP_HEADERS            extra request headers, comma separated "Name=value"
                          pairs (values are never printed)

The default metrics are DELTA sums, which otel-lgtm drops silently when they
are sent straight to it; use the Collector in docs/observability/compose
(same port 4318) or any Collector with the deltatocumulative processor.
Exit code: 0 when every request was accepted, 1 otherwise.
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write(USAGE);
	process.exit(0);
}
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const endpoint = option("--endpoint", process.env.OTEL_DEMO_ENDPOINT ?? "http://localhost:4318");
const workflowCount = Number(option("--workflows", 36));
const langfuse = flag("--langfuse");
// Send content is on by default for an organization, like the real exporter.
const sendContent = !flag("--no-send-content");
if (!Number.isInteger(workflowCount) || workflowCount < 1) {
	process.stderr.write(USAGE);
	process.exit(2);
}

// otel.mjs pulls in db.mjs, which opens a database at import time: point it at
// a throwaway file so no real *.db is touched.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-demo-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "demo.db");
const { buildTraces, buildMetrics, resourceBlock, scopeBlock, attrs, toUnixNano, TEMPORALITY_DELTA } = await import("../otel.mjs");
const { sendOtlp } = await import("../otel-client.mjs");
const { default: pkg } = await import("../package.json", { with: { type: "json" } });

const headers = {};
for (const pair of (process.env.OTLP_HEADERS ?? "").split(",")) {
	const i = pair.indexOf("=");
	if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
}

// ---------------------------------------------------------------- sample world

const RULES = [
	{ id: 1, agent: "*", model: "*", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, effectiveFrom: "" },
	{ id: 2, agent: "*", model: "claude-sonnet-4-5", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, effectiveFrom: "" },
	{ id: 3, agent: "*", model: "claude-opus-4-1", inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75, effectiveFrom: "" },
	// The copilot runner has no rule on purpose: its tokens flow, its cost is "unpriced".
];
const ORGS = [
	{ id: "acme", name: "Acme Corp", runners: [["claude", "claude-sonnet-4-5"], ["claude", "claude-opus-4-1"], ["cursor", "gpt-5"]], failRate: 0.25 },
	{ id: "globex", name: "Globex Industries", runners: [["claude", "claude-sonnet-4-5"], ["free-code", "qwen3-coder"]], failRate: 0.45 },
	// No name and Send content off: its series carry only target.org, which exercises the dashboard's fallback to the id.
	{ id: "initech", sendContent: false, runners: [["copilot", "gpt-5-mini"], ["claude", "claude-sonnet-4-5"]], failRate: 0.35 },
];
/** Whether this sample organization has Send content on (the org setting, unless --no-send-content). */
const contentOn = (org) => sendContent && org.sendContent !== false;
/** The name the exporter would pass as options.orgName; the id when the organization has none. */
const orgNameOf = (org) => org.name ?? org.id;
const NAMES = ["Add search filters", "Refactor auth module", "Fix flaky tests", "Write release notes", "Migrate database schema", "Review pull request"];

// Small seeded generator: a rerun produces the same shape of data (ids differ per run).
let seed = 20261003;
const rand = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo, hi) => lo + rand() * (hi - lo);
const int = (lo, hi) => Math.round(between(lo, hi));
const pick = (list) => list[Math.floor(rand() * list.length)];

const runTag = Date.now().toString(36);
const now = Date.now();
let eventSeq = 0;

/** One workflow as event rows (the `events` table shape). Returns { rows, endMs }. */
function makeWorkflow(n, org, [runner, model], failed, atMs) {
	const wf = `demo-${runTag}-${n}`;
	const session = `sess-${runTag}-${n}`;
	const rows = [];
	let t = atMs;
	const at = (ms) => new Date(ms).toISOString();
	const add = (kind, data, sessionId = null) => {
		rows.push({ id: `${runTag}-${++eventSeq}`, instance_id: "demo", kind, workflow_id: wf, session_id: sessionId, created_at: at(t), received_at: at(t), data });
	};
	const steps = int(3, 6);
	add("workflow.created", { agent: runner, name: pick(NAMES), step_count: steps });
	// A running total, like the real snapshots: it only grows within a session.
	const total = { uncached: 0, creation: 0, read: 0, output: 0 };
	const snapshot = () =>
		add("usage.snapshot", {
			agent: runner,
			model,
			input_tokens: total.uncached + total.creation + total.read,
			input_tokens_uncached: total.uncached,
			cache_creation: total.creation,
			cache_read: total.read,
			output_tokens: total.output,
			context_window: 200000,
			context_tokens: int(20_000, 120_000),
			cost_usd: null,
		}, session);
	const failAt = failed ? int(1, steps - 1) : -1;
	for (let i = 0; i < steps; i++) {
		const stepId = `step-${n}-${i}`;
		const maxRetries = 2;
		// The failing step burns all its retries; other steps occasionally retry once.
		const retries = i === failAt ? maxRetries : rand() < 0.45 ? 1 : 0;
		for (let attempt = 0; attempt <= retries; attempt++) {
			add("step.started", { step_id: stepId, order_index: i, attempt, phase: "exec" });
			const durationMs = Math.round(between(4_000, i === failAt ? 90_000 : 240_000) * (model.includes("opus") ? 1.6 : 1));
			t += durationMs;
			total.uncached += int(2_000, 15_000);
			total.creation += int(5_000, 40_000);
			total.read += int(100_000, 900_000);
			total.output += int(1_500, 12_000);
			snapshot();
			const lastAttempt = attempt === retries;
			if (i === failAt && lastAttempt) {
				add("step.failed", { step_id: stepId, order_index: i, phase: "exec", duration_ms: durationMs, retry_count: attempt, max_retries: maxRetries, error: { kind: "agent_error", message: "demo failure text that is never exported" } });
			} else if (!lastAttempt) {
				add("step.failed", { step_id: stepId, order_index: i, phase: "exec", duration_ms: durationMs, retry_count: attempt, max_retries: maxRetries, error: { kind: "timeout" } });
			} else {
				add("step.done", { step_id: stepId, order_index: i, phase: "exec", duration_ms: durationMs, retry_count: attempt, max_retries: maxRetries });
				add("step.judged", { step_id: stepId, ok: true });
			}
			t += 500;
		}
		if (i === failAt) break;
	}
	add("workflow.status_changed", { from: "running", to: failed ? "failed" : "completed" });
	return { rows, endMs: t };
}

// ---------------------------------------------------------------- generate

// Every workflow ENDS within the last minute (it started a few minutes earlier),
// the way the real exporter sees them: events are exported seconds after they
// happen. Backdated data is not a good demo: Tempo stops returning traces that
// ended well before they were ingested, and Prometheus rejects samples older
// than about an hour.
const plan = [];
for (let n = 0; n < workflowCount; n++) {
	const org = ORGS[n % ORGS.length];
	const pair = pick(org.runners);
	const failed = rand() < org.failRate;
	const made = makeWorkflow(n, org, pair, failed, now);
	const shift = now - between(5_000, 55_000) - made.endMs;
	for (const row of made.rows) row.created_at = row.received_at = new Date(Date.parse(row.received_at) + shift).toISOString();
	plan.push({ org, rows: made.rows });
}
// Send in order of the LAST event: a series whose samples arrive out of order is dropped.
plan.sort((a, b) => Date.parse(a.rows.at(-1).received_at) - Date.parse(b.rows.at(-1).received_at));

// ---------------------------------------------------------------- send

const stats = { requests: 0, accepted: 0, failed: 0, workflows: plan.length, failedWorkflows: 0, spans: 0 };
const state = {};
const failures = [];
async function send(signal, body) {
	const result = await sendOtlp({ endpoint, signal, body, headers });
	stats.requests++;
	if (result.ok) stats.accepted++;
	else {
		stats.failed++;
		failures.push(`${signal}: ${result.error ?? result.status}`);
	}
	if (result.partialSuccess) failures.push(`${signal} partial success: ${JSON.stringify(result.partialSuccess)}`);
	return result;
}

for (const { org, rows } of plan) {
	if (rows.at(-1).data.to === "failed") stats.failedWorkflows++;
	const traces = buildTraces({
		events: rows,
		orgId: org.id,
		serviceVersion: pkg.version,
		options: { rules: RULES, sendContent: contentOn(org), orgName: orgNameOf(org), langfuse, userId: langfuse ? `${org.id}-user@example.com` : null },
	});
	if (traces) {
		stats.spans += traces.resourceSpans[0].scopeSpans[0].spans.length;
		await send("traces", traces);
	}
}

// Metrics go out like the real outbox sends them: per org, in consecutive
// one-minute slices of event time. Delta datapoints of one series must not
// overlap, or the Collector's deltatocumulative processor discards them, so a
// workflow's events are NOT sent as one batch (workflows overlap in time).
if (!langfuse) {
	const SLICE_MS = 60_000;
	const runnerByWorkflow = {};
	const slices = new Map();
	for (const { org, rows } of plan) {
		for (const row of rows) {
			if (row.kind === "workflow.created") runnerByWorkflow[row.workflow_id] = row.data.agent;
			const key = `${Math.floor(Date.parse(row.received_at) / SLICE_MS)}|${org.id}`;
			if (!slices.has(key)) slices.set(key, { org, rows: [] });
			slices.get(key).rows.push(row);
		}
	}
	// Prime the outcome counters with a zero datapoint, as a long-running exporter
	// would already have done: Prometheus increase() cannot see the first sample of
	// a series, and a demo that ends all workflows within a minute would otherwise
	// show the completed/failed panels empty. The primer sits exactly on the boundary of
	// the slice that holds the first workflow end: a later delta interval that started
	// before it would overlap it and be discarded by the Collector. That is also
	// at most a minute before the first end, inside the dashboard's rate window.
	const firstEndMs = Math.min(...plan.map((p) => Date.parse(p.rows.at(-1).received_at)));
	const sliceStartMs = Math.floor(firstEndMs / SLICE_MS) * SLICE_MS;
	const primeNs = toUnixNano(sliceStartMs);
	const primeStartNs = toUnixNano(sliceStartMs - 1_000);
	const primeNames = [
		["target.workflow.completed", "{workflow}"],
		["target.workflow.failed", "{workflow}"],
	];
	const sendPrimers = async () => {
		for (const org of ORGS) {
			const runners = [...new Set(org.runners.map(([runner]) => runner))];
			const point = (runner) => ({ attributes: attrs({ "target.org": org.id, "target.org.name": contentOn(org) ? orgNameOf(org) : undefined, "target.runner": runner }), startTimeUnixNano: primeStartNs, timeUnixNano: primeNs, asInt: "0" });
			const request = {
				resourceMetrics: [
					{
						resource: resourceBlock({ org: org.id, orgName: contentOn(org) ? orgNameOf(org) : undefined, serviceVersion: pkg.version }),
						scopeMetrics: [
							{
								scope: scopeBlock({ serviceVersion: pkg.version }),
								metrics: primeNames.map(([name, unit]) => ({
									name,
									unit,
									sum: { aggregationTemporality: TEMPORALITY_DELTA, isMonotonic: true, dataPoints: runners.map(point) },
								})),
							},
						],
					},
				],
			};
			await send("metrics", request);
		}
	};
	const ordered = [...slices.entries()].sort(([a], [b]) => Number(a.split("|")[0]) - Number(b.split("|")[0]));
	// Samples of one series must arrive in time order or Prometheus rejects the
	// whole request (the series include target_info, which every org's earlier
	// slices also write), so the primer is sent when the sequence of slices
	// reaches the one that holds the first workflow end, not before.
	const firstEndBucket = Math.floor(firstEndMs / SLICE_MS);
	let primed = false;
	for (const [key, { org, rows }] of ordered) {
		if (!primed && Number(key.split("|")[0]) >= firstEndBucket) {
			await sendPrimers();
			primed = true;
		}
		const metrics = buildMetrics({
			events: rows,
			orgId: org.id,
			serviceVersion: pkg.version,
			stateBySession: state,
			rules: RULES,
			runnerByWorkflow,
			options: { sendContent: contentOn(org), orgName: orgNameOf(org) },
		});
		Object.assign(state, metrics.state);
		if (metrics.request) await send("metrics", metrics.request);
	}
	if (!primed) await sendPrimers();
}

fs.rmSync(tmpDir, { recursive: true, force: true });
const orgs = [...new Set(plan.map((p) => p.org.id))].join(", ");
console.log(`endpoint: ${endpoint}`);
console.log(`workflows: ${stats.workflows} (${stats.failedWorkflows} failed) across orgs ${orgs}; spans: ${stats.spans}`);
console.log(`requests: ${stats.requests}, accepted: ${stats.accepted}, failed: ${stats.failed}`);
for (const f of failures) console.error(`  ${f}`);
process.exit(stats.failed === 0 && stats.accepted > 0 ? 0 : 1);
