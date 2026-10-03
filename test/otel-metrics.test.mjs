/**
 * Usage deltas, cost and metrics: a snapshot is a running TOTAL, so exporting
 * must diff it against what was already exported and never double count.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TARGET_SERVER_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-otel-")), "t.db");
const { buildMetrics, computeUsageDelta, STEP_DURATION_BOUNDS } = await import("../otel.mjs");
const { normalizeUsageSnapshot } = await import("../db.mjs");
const { computeCost, priceSession } = await import("../pricing.mjs");

const RULES = [
	{ id: 1, agent: "*", model: "*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, effectiveFrom: "" },
];
const WF = "wf-secret-id";
const SESSION = "session-secret-id";
const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

let seq = 0;
const ev = (kind, sec, data, session = null) => ({ id: `e${++seq}`, kind, workflow_id: WF, session_id: session, created_at: iso(sec), received_at: iso(sec), data });
/** New-shape payload: input_tokens is the full total. */
const payload = ({ uncached, creation, read, output, model = "claude-sonnet-4-5", ...rest }) => ({
	input_tokens: uncached + creation + read,
	input_tokens_uncached: uncached,
	cache_creation: creation,
	cache_read: read,
	output_tokens: output,
	context_window: 200000,
	context_tokens: 10,
	model,
	cost_usd: null,
	...rest,
});
const snap = (sec, p) => ev("usage.snapshot", sec, p, SESSION);

// Three running totals of ONE session, cache heavy like the real data.
const S1 = payload({ uncached: 100_000, creation: 200_000, read: 1_000_000, output: 10_000 });
const S2 = payload({ uncached: 150_000, creation: 250_000, read: 4_000_000, output: 40_000 });
const S3 = payload({ uncached: 200_000, creation: 300_000, read: 10_000_000, output: 100_000 });

const metricOf = (request, name) => request.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
const points = (request, name) => {
	const m = metricOf(request, name);
	return m ? (m.sum ?? m.histogram).dataPoints : [];
};
const attrOf = (point, key) => point.attributes.find((a) => a.key === key)?.value;
const tokenTotal = (request) =>
	Object.fromEntries(points(request, "target.tokens").map((p) => [attrOf(p, "token.type").stringValue, Number(p.asInt)]));

test("computeUsageDelta: first snapshot is the whole total, priced on four buckets", () => {
	const d = computeUsageDelta({ previousState: null, snapshot: S1, rules: RULES, agent: "claude", at: iso(1) });
	assert.deepEqual(d.tokens, { input: 100_000, output: 10_000, cache_read: 1_000_000, cache_creation: 200_000 });
	// The same figure pricing-core's computeCost gives for the four buckets.
	close(d.costDeltaUsd, computeCost(RULES[0], normalizeUsageSnapshot(S1)));
	close(d.costDeltaUsd, (100_000 * 3 + 200_000 * 3.75 + 1_000_000 * 0.3 + 10_000 * 15) / 1e6);
	assert.equal(d.costSource, "pricing");
	assert.equal(d.partial, false);
});

test("cache reads are not priced at the input rate", () => {
	const usage = payload({ uncached: 2e6, creation: 0, read: 57e6, output: 0 });
	const d = computeUsageDelta({ snapshot: usage, rules: [{ ...RULES[0], inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5 }], agent: "claude" });
	close(d.costDeltaUsd, 2 * 15 + 57 * 1.5);
});

test("three consecutive snapshots: deltas sum to the final total, no double counting", () => {
	let state = null;
	const sum = { tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, cost: 0 };
	for (const [i, s] of [S1, S2, S3].entries()) {
		const d = computeUsageDelta({ previousState: state, snapshot: s, rules: RULES, agent: "claude", at: iso(i) });
		state = d.nextState;
		for (const k of Object.keys(sum.tokens)) sum.tokens[k] += d.tokens[k];
		sum.cost += d.costDeltaUsd;
	}
	assert.deepEqual(sum.tokens, { input: 200_000, output: 100_000, cache_read: 10_000_000, cache_creation: 300_000 });
	const final = priceSession(RULES, { agent: "claude", at: iso(2), usage: normalizeUsageSnapshot(S3) });
	close(sum.cost, final.costUsd);
});

test("re-processing the same snapshot gives zero delta", () => {
	const first = computeUsageDelta({ snapshot: S2, rules: RULES, agent: "claude" });
	const again = computeUsageDelta({ previousState: first.nextState, snapshot: S2, rules: RULES, agent: "claude" });
	assert.deepEqual(again.tokens, { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
	assert.equal(again.costDeltaUsd, 0);
	assert.deepEqual(again.nextState, first.nextState);
});

test("unpriced then priced: tokens always flow, the later rule covers the backlog", () => {
	const a = computeUsageDelta({ snapshot: S1, rules: [], agent: "copilot" });
	assert.equal(a.costDeltaUsd, null);
	assert.equal(a.costSource, "unpriced");
	assert.equal(a.partial, true);
	assert.equal(a.tokens.output, 10_000);
	assert.equal(a.nextState.costUsd, 0);
	const b = computeUsageDelta({ previousState: a.nextState, snapshot: S2, rules: RULES, agent: "copilot" });
	assert.equal(b.partial, false);
	assert.equal(b.tokens.output, 30_000);
	// Everything not yet exported: the cost of the whole S2 total.
	close(b.costDeltaUsd, priceSession(RULES, { agent: "copilot", usage: normalizeUsageSnapshot(S2) }).costUsd);
});

test("a hub cost wins and is diffed like any other cumulative cost", () => {
	const a = computeUsageDelta({ snapshot: { ...S1, cost_usd: 2 }, rules: RULES, agent: "claude" });
	assert.equal(a.costSource, "hub");
	assert.equal(a.costDeltaUsd, 2);
	const b = computeUsageDelta({ previousState: a.nextState, snapshot: { ...S2, cost_usd: 5 }, rules: RULES, agent: "claude" });
	assert.equal(b.costDeltaUsd, 3);
});

test("compaction: a lower total clamps to zero and becomes the new state", () => {
	const high = computeUsageDelta({ snapshot: S3, rules: RULES, agent: "claude" });
	const low = computeUsageDelta({ previousState: high.nextState, snapshot: S1, rules: RULES, agent: "claude" });
	assert.deepEqual(low.tokens, { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
	assert.equal(low.costDeltaUsd, 0);
	assert.deepEqual(low.nextState.tokens, { input: 100_000, output: 10_000, cache_read: 1_000_000, cache_creation: 200_000 });
	// Growth after the reset is counted from the new, lower state.
	const next = computeUsageDelta({ previousState: low.nextState, snapshot: S2, rules: RULES, agent: "claude" });
	assert.equal(next.tokens.output, 30_000);
	assert.ok(next.costDeltaUsd > 0);
});

test("old-shape payloads are normalised before the diff", () => {
	const old = { input_tokens: 416, output_tokens: 98599, cache_read: 14409380, cache_creation: 1605396, cost_usd: null };
	const d = computeUsageDelta({ snapshot: old, rules: RULES, agent: "claude" });
	assert.equal(d.tokens.input, 416);
	assert.equal(d.tokens.cache_read, 14409380);
});

test("buildMetrics: three snapshots in one batch export the final total once", () => {
	const events = [snap(1, S1), snap(2, S2), snap(3, S3)];
	const { request, state } = buildMetrics({ events, orgId: "demo", serviceVersion: "0.1.0", rules: RULES, runnerByWorkflow: { [WF]: "claude" } });
	assert.deepEqual(tokenTotal(request), { input: 200_000, output: 100_000, cache_read: 10_000_000, cache_creation: 300_000 });
	const cost = points(request, "target.cost.usd");
	assert.equal(cost.length, 1);
	close(cost[0].asDouble, priceSession(RULES, { agent: "claude", usage: normalizeUsageSnapshot(S3) }).costUsd);
	assert.equal(Object.keys(state).length, 1);
});

test("buildMetrics: batches over time sum to the final total; a replay exports nothing", () => {
	const m1 = buildMetrics({ events: [snap(1, S1)], orgId: "demo", stateBySession: {}, rules: RULES, runnerByWorkflow: { [WF]: "claude" } });
	const m2 = buildMetrics({ events: [snap(2, S2), snap(3, S3)], orgId: "demo", stateBySession: m1.state, rules: RULES, runnerByWorkflow: { [WF]: "claude" } });
	const total = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
	let cost = 0;
	for (const m of [m1, m2]) {
		for (const [k, v] of Object.entries(tokenTotal(m.request))) total[k] += v;
		for (const p of points(m.request, "target.cost.usd")) cost += p.asDouble;
	}
	assert.deepEqual(total, { input: 200_000, output: 100_000, cache_read: 10_000_000, cache_creation: 300_000 });
	close(cost, priceSession(RULES, { agent: "claude", usage: normalizeUsageSnapshot(S3) }).costUsd);

	const replay = buildMetrics({ events: [snap(1, S1), snap(2, S2), snap(3, S3)], orgId: "demo", stateBySession: m2.state, rules: RULES, runnerByWorkflow: { [WF]: "claude" } });
	assert.equal(replay.request, null);
	assert.deepEqual(replay.state, m2.state);
	assert.equal(buildMetrics({ events: [], orgId: "demo" }).request, null);
});

test("buildMetrics: unpriced usage exports tokens but no cost point", () => {
	const { request } = buildMetrics({ events: [snap(1, S1)], orgId: "demo", rules: [], runnerByWorkflow: { [WF]: "copilot" } });
	assert.equal(tokenTotal(request).output, 10_000);
	assert.equal(metricOf(request, "target.cost.usd"), undefined);
});

test("step duration histogram: buckets, count, sum, min, max, in seconds", () => {
	const done = (sec, i, ms, extra = {}) => ev("step.done", sec, { step_id: `s${i}`, order_index: i, duration_ms: ms, retry_count: 0, ...extra });
	const events = [done(10, 0, 500), done(20, 1, 5000), done(30, 2, 7000), done(40, 3, 4_000_000)];
	const { request } = buildMetrics({ events, orgId: "demo", runnerByWorkflow: { [WF]: "claude" } });
	const metric = metricOf(request, "target.step.duration");
	assert.equal(metric.unit, "s");
	assert.equal(metric.histogram.aggregationTemporality, 1);
	const [p] = metric.histogram.dataPoints;
	assert.deepEqual(p.explicitBounds, STEP_DURATION_BOUNDS);
	assert.equal(p.bucketCounts.length, STEP_DURATION_BOUNDS.length + 1);
	// 0.5s → (-inf,1]; 5s → (1,5] (upper bound inclusive); 7s → (5,10]; 4000s → overflow
	assert.deepEqual(p.bucketCounts, ["1", "1", "1", "0", "0", "0", "0", "0", "0", "0", "1"]);
	assert.equal(p.count, "4");
	close(p.sum, 0.5 + 5 + 7 + 4000);
	assert.equal(p.min, 0.5);
	assert.equal(p.max, 4000);
	assert.equal(p.bucketCounts.reduce((n, c) => n + Number(c), 0), 4);
});

test("retries count once per step, from the attempt that ends it", () => {
	const events = [
		ev("step.failed", 5, { step_id: "s0", order_index: 0, duration_ms: 1000, retry_count: 0, max_retries: 2, error: { kind: "x" } }),
		ev("step.done", 9, { step_id: "s0", order_index: 0, duration_ms: 1000, retry_count: 1 }),
		ev("step.done", 12, { step_id: "s1", order_index: 1, duration_ms: 1000, retry_count: 0 }),
	];
	const { request } = buildMetrics({ events, orgId: "demo" });
	assert.equal(points(request, "target.step.retries").length, 1);
	assert.equal(points(request, "target.step.retries")[0].asInt, "1");
	assert.equal(points(request, "target.step.duration").length, 1);
	assert.equal(points(request, "target.step.duration")[0].count, "3");
});

test("completed and failed workflow counters", () => {
	const status = (sec, to) => ev("workflow.status_changed", sec, { from: "running", to, manual: false });
	const events = [status(1, "completed"), status(2, "failed"), status(3, "completed"), status(4, "paused")];
	const { request } = buildMetrics({ events, orgId: "demo", runnerByWorkflow: { [WF]: "claude" } });
	const completed = metricOf(request, "target.workflow.completed");
	assert.equal(completed.sum.dataPoints[0].asInt, "2");
	assert.equal(completed.sum.isMonotonic, true);
	assert.equal(completed.sum.aggregationTemporality, 1);
	assert.equal(metricOf(request, "target.workflow.failed").sum.dataPoints[0].asInt, "1");
});

test("metric attributes are only org, runner and model (+ token.type): no workflow, session or user", () => {
	const events = [
		ev("workflow.created", 0, { name: "n", agent: "claude", step_count: 1 }),
		ev("step.done", 5, { step_id: "step-secret-id", order_index: 0, duration_ms: 2000, retry_count: 1 }),
		snap(6, { ...S2, user: "alice@example.com" }),
		ev("workflow.status_changed", 9, { from: "running", to: "completed", manual: false }),
	];
	const { request } = buildMetrics({ events, orgId: "demo", serviceVersion: "0.1.0", rules: RULES });
	const allowed = new Set(["target.org", "target.runner", "gen_ai.request.model", "token.type"]);
	let count = 0;
	for (const metric of request.resourceMetrics[0].scopeMetrics[0].metrics) {
		for (const p of (metric.sum ?? metric.histogram).dataPoints) {
			count++;
			for (const a of p.attributes) assert.ok(allowed.has(a.key), `${metric.name}: unexpected attribute ${a.key}`);
			assert.equal(attrOf(p, "target.org").stringValue, "demo");
			assert.equal(attrOf(p, "target.runner").stringValue, "claude");
		}
	}
	assert.ok(count >= 5);
	const text = JSON.stringify(request);
	for (const secret of [WF, SESSION, "step-secret-id", "alice@example.com"]) assert.ok(!text.includes(secret), `${secret} leaked`);
	// Only token.type is a free dimension and it has four fixed values.
	assert.deepEqual(Object.keys(tokenTotal(request)).sort(), ["cache_creation", "cache_read", "input", "output"]);
});

test("encoding: delta temporality, string 64-bit ints and timestamps, model only when known", () => {
	const events = [snap(1, S1), snap(2, payload({ uncached: 1, creation: 1, read: 1, output: 1, model: null }))];
	const { request } = buildMetrics({ events, orgId: "demo", rules: RULES, runnerByWorkflow: { [WF]: "claude" } });
	for (const m of request.resourceMetrics[0].scopeMetrics[0].metrics) {
		assert.equal((m.sum ?? m.histogram).aggregationTemporality, 1);
		for (const p of (m.sum ?? m.histogram).dataPoints) {
			assert.equal(typeof p.startTimeUnixNano, "string");
			assert.equal(typeof p.timeUnixNano, "string");
			if (p.asInt !== undefined) assert.equal(typeof p.asInt, "string");
		}
	}
	assert.ok(!/"(startTimeUnixNano|timeUnixNano)":\d/.test(JSON.stringify(request)));
	// Last snapshot has no model: the model attribute is omitted rather than empty.
	assert.equal(attrOf(points(request, "target.tokens")[0], "gen_ai.request.model"), undefined);
});

test("buildMetrics: target.org.name on the resource and every data point only with sendContent", () => {
	const events = [snap(1, S1), ev("step.done", 2, { step_id: "s1", duration_ms: 1000 }), ev("workflow.status_changed", 3, { from: "running", to: "completed" })];
	const run = (options) => buildMetrics({ events, orgId: "org-1", rules: RULES, runnerByWorkflow: { [WF]: "claude" }, options }).request;
	const on = run({ sendContent: true, orgName: "Acme Corp" });
	const resource = on.resourceMetrics[0].resource.attributes.find((a) => a.key === "target.org.name");
	assert.equal(resource.value.stringValue, "Acme Corp");
	const all = on.resourceMetrics[0].scopeMetrics[0].metrics.flatMap((m) => (m.sum ?? m.histogram).dataPoints);
	assert.ok(all.length > 3);
	for (const p of all) {
		assert.equal(attrOf(p, "target.org").stringValue, "org-1");
		assert.equal(attrOf(p, "target.org.name").stringValue, "Acme Corp");
		// Cardinality rule: never workflow, session, user or step ids.
		assert.ok(p.attributes.every((a) => /^(target\.org|target\.org\.name|target\.runner|gen_ai\.request\.model|token\.type|target\.[a-z.]*status)$/.test(a.key) || !/workflow|session|user|step/.test(a.key)), JSON.stringify(p.attributes));
	}
	assert.equal(JSON.stringify(on).includes(WF), false);
	assert.equal(JSON.stringify(on).includes(SESSION), false);
	assert.equal(run({ sendContent: true }).resourceMetrics[0].resource.attributes.find((a) => a.key === "target.org.name").value.stringValue, "org-1");
	const off = run({ sendContent: false, orgName: "Acme Corp" });
	assert.ok(!JSON.stringify(off).includes("target.org.name"));
	assert.ok(!JSON.stringify(off).includes("Acme Corp"));
	assert.deepEqual(off, run(undefined));
});
