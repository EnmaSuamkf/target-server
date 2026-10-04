/**
 * buildMetrics in cumulative mode: persisted running totals, a stable start
 * time per series, replay safety, histogram merge. Delta mode is the default
 * and is covered by otel-metrics.test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TARGET_SERVER_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-otel-cum-")), "t.db");
const { buildMetrics, STEP_DURATION_BOUNDS } = await import("../otel.mjs");

const RULES = [{ id: 1, agent: "*", model: "*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, effectiveFrom: "" }];
const WF = "wf-1";
const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const nano = (sec) => String(BigInt(T0 + sec * 1000) * 1_000_000n);
let seq = 0;
const ev = (kind, sec, data, session = null) => ({ id: `e${++seq}`, kind, workflow_id: WF, session_id: session, created_at: iso(sec), received_at: iso(sec), data });
const usage = (uncached, output) => ({ input_tokens: uncached, input_tokens_uncached: uncached, cache_creation: 0, cache_read: 0, output_tokens: output, model: "claude-sonnet-4-5", cost_usd: null });
const snap = (sec, u) => ev("usage.snapshot", sec, u, "s1");
const done = (sec, seconds) => ev("step.done", sec, { duration_ms: seconds * 1000, retry_count: 0, max_retries: 2 });
const base = { orgId: "demo", rules: RULES, runnerByWorkflow: { [WF]: "claude" }, temporality: "cumulative" };

const metricOf = (request, name) => request?.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
const pointsOf = (request, name) => {
	const m = metricOf(request, name);
	return m ? (m.sum ?? m.histogram).dataPoints : [];
};
const tokenPoint = (request, type) => pointsOf(request, "target.tokens").find((p) => p.attributes.find((a) => a.key === "token.type")?.value.stringValue === type);

test("cumulative: aggregationTemporality 2 and running totals grow across batches", () => {
	const m1 = buildMetrics({ ...base, events: [snap(1, usage(100, 10))] });
	assert.equal(metricOf(m1.request, "target.tokens").sum.aggregationTemporality, 2);
	assert.equal(metricOf(m1.request, "target.cost.usd").sum.aggregationTemporality, 2);
	assert.equal(tokenPoint(m1.request, "input").asInt, "100");

	const m2 = buildMetrics({ ...base, events: [snap(2, usage(300, 40))], stateBySession: m1.state, seriesByKey: m1.series });
	assert.equal(tokenPoint(m2.request, "input").asInt, "300", "100 + 200, not the batch delta");
	assert.equal(tokenPoint(m2.request, "output").asInt, "40");
	const cost1 = pointsOf(m1.request, "target.cost.usd")[0].asDouble;
	const cost2 = pointsOf(m2.request, "target.cost.usd")[0].asDouble;
	assert.ok(cost2 > cost1);
	assert.equal(m2.state["wf-1:s1"].tokens.input, 300);
});

test("cumulative: startTimeUnixNano is the series start, timeUnixNano the latest event", () => {
	const m1 = buildMetrics({ ...base, events: [snap(5, usage(100, 10)), snap(7, usage(120, 10))] });
	const p1 = tokenPoint(m1.request, "input");
	assert.equal(p1.startTimeUnixNano, nano(5));
	assert.equal(p1.timeUnixNano, nano(7));
	const m2 = buildMetrics({ ...base, events: [snap(60, usage(500, 10))], stateBySession: m1.state, seriesByKey: m1.series });
	const p2 = tokenPoint(m2.request, "input");
	assert.equal(p2.startTimeUnixNano, nano(5), "unchanged by a later batch");
	assert.equal(p2.timeUnixNano, nano(60));
	const m3 = buildMetrics({ ...base, events: [snap(90, usage(900, 10))], stateBySession: m2.state, seriesByKey: m2.series });
	assert.equal(tokenPoint(m3.request, "input").startTimeUnixNano, nano(5));
	assert.equal(pointsOf(m3.request, "target.cost.usd")[0].startTimeUnixNano, nano(5));
});

test("cumulative: replay with the returned state and series exports nothing", () => {
	const events = [snap(1, usage(100, 10)), snap(2, usage(300, 40))];
	const m = buildMetrics({ ...base, events });
	const replay = buildMetrics({ ...base, events, stateBySession: m.state, seriesByKey: m.series });
	assert.equal(replay.request, null);
	assert.deepEqual(replay.state, m.state);
	assert.deepEqual(replay.series, m.series);
	assert.deepEqual(replay.changedSeries, []);
});

test("cumulative: unchanged series are not re-sent and the input series map is not mutated", () => {
	const m1 = buildMetrics({ ...base, events: [snap(1, usage(100, 10)), ev("workflow.status_changed", 1, { to: "completed" })] });
	const frozen = JSON.stringify(m1.series);
	const m2 = buildMetrics({ ...base, events: [snap(2, usage(150, 10))], stateBySession: m1.state, seriesByKey: m1.series });
	assert.equal(JSON.stringify(m1.series), frozen);
	assert.equal(metricOf(m2.request, "target.workflow.completed"), undefined);
	assert.ok(m2.series[m2.changedSeries[0]]);
	assert.ok(Object.keys(m2.series).length >= Object.keys(m1.series).length);
});

test("cumulative: step duration histogram merges count, sum, buckets, min and max", () => {
	const m1 = buildMetrics({ ...base, events: [done(1, 2), done(2, 40)] });
	const m2 = buildMetrics({ ...base, events: [done(70, 0.5), done(71, 4000)], seriesByKey: m1.series });
	const h = metricOf(m2.request, "target.step.duration").histogram;
	assert.equal(h.aggregationTemporality, 2);
	const [p] = h.dataPoints;
	assert.equal(p.count, "4");
	assert.equal(p.sum, 2 + 40 + 0.5 + 4000);
	assert.equal(p.min, 0.5);
	assert.equal(p.max, 4000);
	assert.equal(p.startTimeUnixNano, nano(1));
	assert.equal(p.bucketCounts.length, STEP_DURATION_BOUNDS.length + 1);
	assert.equal(p.bucketCounts.reduce((a, b) => a + Number(b), 0), 4);
	assert.equal(p.bucketCounts[0], "1"); // 0.5s <= 1
	assert.equal(p.bucketCounts[1], "1"); // 2s <= 5
	assert.equal(p.bucketCounts[4], "1"); // 40s <= 60
	assert.equal(p.bucketCounts[STEP_DURATION_BOUNDS.length], "1"); // 4000s > 3600
});

test("cumulative: zero values are not emitted and series stay per (metric, attributes)", () => {
	assert.equal(buildMetrics({ ...base, events: [snap(1, usage(0, 0))] }).request, null);
	const m = buildMetrics({ ...base, events: [snap(1, usage(100, 10))] });
	for (const s of Object.values(m.series)) {
		const keys = s.attributes.map((a) => a.key);
		assert.ok(!keys.some((k) => /workflow|session|user|step/.test(k)), keys.join());
		assert.equal(s.key, `${s.name}|${JSON.stringify(s.attributes)}`);
	}
});

test("delta (default and explicit): aggregationTemporality 1, per-batch values, no series written", () => {
	const m1 = buildMetrics({ ...base, temporality: "delta", events: [snap(1, usage(100, 10)), done(1, 3)] });
	const m2 = buildMetrics({ orgId: "demo", rules: RULES, runnerByWorkflow: { [WF]: "claude" }, events: [snap(2, usage(300, 40))], stateBySession: m1.state });
	assert.equal(metricOf(m1.request, "target.tokens").sum.aggregationTemporality, 1);
	assert.equal(metricOf(m1.request, "target.step.duration").histogram.aggregationTemporality, 1);
	assert.equal(tokenPoint(m2.request, "input").asInt, "200");
	assert.equal(tokenPoint(m2.request, "input").startTimeUnixNano, nano(2), "delta start is the batch's first event");
	assert.deepEqual(m1.series, {});
	assert.deepEqual(m1.changedSeries, []);
});
